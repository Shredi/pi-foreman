"""R13 item 1: scripts/shell_facts.py reports the write surfaces of a shell line (git guard Lexer, no verdict)."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import shell_facts as sf  # noqa: E402


class ShellFactsTest(unittest.TestCase):
    def setUp(self):
        self.cwd = os.path.realpath(tempfile.mkdtemp(prefix="pf-sf-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.cwd, True))

    def writes(self, command, shell="bash", scratch=None):
        f = sf.facts({"command": command, "cwd": self.cwd, "shell": shell, "scratch_dir": scratch})
        self.assertIsNone(f["error"], command)
        return f["writes"]

    def kinds(self, command, **kw):
        return [(w["kind"], w["path"]) for w in self.writes(command, **kw)]

    def test_redirects_on_any_fd_and_op(self):
        for op in (">", ">>", ">|", "&>", "2>", "&>>"):
            self.assertEqual(self.kinds("echo A %s /x/out" % op), [("redirect", "/x/out")], op)
        self.assertEqual(self.kinds("exec 3> /x/out"), [("redirect", "/x/out")])
        self.assertEqual(self.kinds("echo A 2>&1 >/dev/null"), [])

    def test_reads_and_heredoc_bodies_are_no_writes(self):
        self.assertEqual(self.writes("ls -la $D; cat $D/parent; grep -rln x ."), [])
        self.assertEqual(self.writes("cat <<'EOF'\n> /x/ruling.md $25 [\nEOF"), [])

    def test_cd_is_tracked_and_substitution_cd_is_not(self):
        os.mkdir(os.path.join(self.cwd, "sub"))
        self.assertEqual(self.kinds("cd sub && echo A > f"), [("redirect", os.path.join(self.cwd, "sub", "f"))])
        self.assertEqual(self.kinds("echo $(cd /tmp) > f"), [("redirect", os.path.join(self.cwd, "f"))])
        w = self.writes("cd $X && echo A > f")[0]
        self.assertIsNone(w["path"])
        self.assertEqual(w["name"], "f")

    def test_copiers_report_sources_and_destinations(self):
        k = self.kinds("cp /a/plan.md /s")
        self.assertIn(("source", "/a/plan.md"), k)
        self.assertIn(("dest", "/s"), k)
        self.assertIn(("dest", "/s/plan.md"), k)
        self.assertIn(("dest", "/h/ruling.md"), self.kinds("cp -t /h ruling.md"))

    def test_named_write_forms(self):
        self.assertEqual(self.kinds("echo A | dd of=/h/r"), [("dd", "/h/r")])
        self.assertEqual(self.kinds("sed -i s/a/b/ /h/r"), [("sed-i", "/h/r")])
        self.assertEqual(self.kinds("sort -uo /h/r x"), [("sort", "/h/r")])
        self.assertEqual(self.kinds("echo A | tee -a /h/r"), [("tee", "/h/r")])
        self.assertEqual(self.kinds("truncate -s 0 /h/r"), [("truncate", "/h/r")])
        self.assertEqual(self.kinds("git diff --output=/h/r"), [("output", "/h/r")])
        self.assertEqual(self.kinds("curl -o /h/r https://e/x"), [("curl", "/h/r")])

    def test_nested_shell_and_command_env_values(self):
        self.assertEqual(self.kinds('sh -c "echo A > /h/r"'), [("redirect", "/h/r")])
        self.assertEqual(self.kinds("bash <<'EOF'\necho A > /h/r\nEOF"), [("redirect", "/h/r")])
        self.assertEqual(self.kinds('GIT_PAGER="dd of=/h/r" git show'), [("dd", "/h/r")])

    def test_computed_targets_are_unresolved(self):
        w = self.writes("cp x $N")
        self.assertTrue(any(x["kind"] == "dest" and x["name"] is None for x in w))
        w = self.writes("cat x > $OUT/ruling.md")[0]
        self.assertEqual((w["dir"], w["name"]), (None, "ruling.md"))

    def test_bound_variables_and_harness_scratch(self):
        self.assertEqual(self.kinds("D=/h; echo A > $D/r"), [("redirect", "/h/r")])
        self.assertEqual(self.kinds("echo A > $FOREMAN_SCRATCH/x", scratch="/s"), [("redirect", "/s/x")])
        w = self.writes("FOREMAN_SCRATCH=/h; echo A > $FOREMAN_SCRATCH/x", scratch="/s")[0]
        self.assertIsNone(w["path"])

    def test_interpreter_code_writes(self):
        self.assertEqual(self.kinds("python3 -c \"open('/h/r','w')\""), [("code", "/h/r")])
        self.assertEqual(self.kinds("python3 - <<'EOF'\nimport json\nprint(json.load(open('/s/x.json')))\nEOF"), [])
        self.assertEqual(self.kinds("node w.js /h/ruling.md"), [("arg", "/h/ruling.md")])
        self.assertEqual(self.kinds("node w.js $D $N"), [])

    def test_links_and_powershell(self):
        self.assertTrue(sf.facts({"command": "ln -s /h lnk", "cwd": self.cwd})["links"])
        self.assertTrue(sf.facts({"command": "perl -e 'symlink(\"/h\",\"/tmp/d\")'", "cwd": self.cwd})["links"])
        self.assertIn(("cmdlet", "/h/ruling.md"), self.kinds("Set`-Location /h; Set-Content ruling.md APPROVED", shell="powershell"))

    def test_review_round1_deny_cases_have_unknown_dir(self):
        cases = {
            "computed sh -c": 'sh -c "$C"',
            "computed eval": 'eval "$C"',
            "sed e command": "sed '1e touch /h/ruling.md' /s/x",
            "sed s///e": "sed 's|.*|touch /h/ruling.md|e' /s/x",
            "xargs touch from stdin": "echo /h/ruling.md | xargs touch",
            "awk system": "awk 'BEGIN{system(\"touch /h/ruling.md\")}'",
            "find -exec": "find /h -name ruling.md -exec touch {} +",
        }
        for name, line in cases.items():
            w = self.writes(line)
            self.assertTrue(any(x["dir"] is None and x["name"] in (None, "ruling.md") for x in w), (name, w))
        self.assertEqual(self.writes("sed -n 's/a/b/p' /s/x"), [])

    def test_review_round2_deny_cases_are_fully_computed(self):
        cases = {
            "find -exec sh -c": "find /h -name 'r*.md' -exec sh -c 'echo APPROVED > \"$1\"' _ {} \\;",
            "find -exec touch +": "find /h -type f -exec touch {} +",
            "find -execdir": "find /h -execdir touch x \\;",
            "find -ok": "find /h -ok touch {} \\;",
            "find -delete": "find /h -name x -delete",
            "find -fprint": "find /h -fprint /s/out",
            "sed --expression=": "sed --expression='1e touch /h/ruling.md' /s/x",
            "sed --expression X": "sed --expression '1e touch /h/ruling.md' /s/x",
            "sed -eX": "sed '-e1e touch /h/ruling.md' /s/x",
            "sed -ne X": "sed -ne '1e touch /h/ruling.md' /s/x",
            "sed custom address": "sed '\\,a,e touch /h/ruling.md' /s/x",
            "sed custom address after comma": "sed '1,\\cxce touch /h/ruling.md' /s/x",
            "sed -f": "sed -f script.sed /s/x",
            "sed --file=": "sed --file=script.sed /s/x",
            "sed computed script": 'sed "$S" /s/x',
        }
        for name, line in cases.items():
            w = self.writes(line)
            self.assertTrue(any(x["dir"] is None and x["name"] is None for x in w), (name, w))
        for line in ("find /h -name x -print", "ls /h", "grep -rln x /h", "sed -n 's/a/b/p' /s/x",
                     "sed -n -e 's/a/b/p' -e '1,3p' /s/x", "sed --expression=s/a/b/ /s/x", "sed -E 's/x+/y/' /s/x"):
            self.assertEqual(self.writes(line), [], line)

    def test_review_round3_deny_cases_are_fully_computed(self):
        cases = {
            "sed 1w": "sed -n '1w /h/ruling.md' /s/x",
            "sed $w": "sed -n '$w /h/ruling.md' /s/x",
            "sed s|a|b|w": "sed 's|a|b|w /h/ruling.md' /s/x",
            "sed 1,+2e": "sed '1,+2e touch /h/ruling.md' /s/x",
            "sed 1 ! e": "sed '1 ! e touch /h/ruling.md' /s/x",
            "sed --expr=": "sed --expr='1e touch /h/ruling.md' /s/x",
            "sed --fi=": "sed --fi=script.sed /s/x",
            "sed --in": "sed --in s/a/b/ /h/ruling.md",
            "find computed action $A": "find /h -name ruling.md $A touch {} +",
            "find quoted \"$A\"": "find /h -name ruling.md \"$A\" touch {} +",
        }
        for name, line in cases.items():
            w = self.writes(line)
            self.assertTrue(any(x["dir"] is None and x["name"] is None for x in w), (name, w))
        for line in ("sed -n 's/a/b/p' /s/x", "sed --quiet --regexp-extended 's/x+/y/p' /s/x", "find /h -name x -print"):
            self.assertEqual(self.writes(line), [], line)

    def test_review_round4_computed_program_and_sed_words_are_fully_computed(self):
        cases = {
            "$Q -i": "$Q -i s/a/b/ /h/ruling.md",
            "Q=sed; $Q -i": "Q=sed; $Q -i s/a/b/ /h/ruling.md",
            '"$C" -i': '"$C" -i s/a/b/ /h/ruling.md',
            "$(echo sed) -i": "$(echo sed) -i s/a/b/ /h/ruling.md",
            "$Q ruling": "$Q /h/ruling.md",
            "sed $OPT": "sed s/a/b/ $OPT /h/ruling.md",
            "OPT=-i; sed $OPT": "OPT=-i; sed s/a/b/ $OPT /h/ruling.md",
            'sed -e "$O"': 'sed -e s/a/b/ "$O" /h/ruling.md',
        }
        for name, line in cases.items():
            w = self.writes(line)
            self.assertTrue(any(x["dir"] is None and x["name"] is None for x in w), (name, w))
        self.assertEqual(self.writes("D=/h; ls -la $D; cat $D/parent"), [])

    def test_r14_residual_deny_rows_are_fully_computed(self):
        cases = {
            "awk redirect to a bound variable operand": "f=/h/ruling.md; awk '{print > f}' f=\"$f\" /s/x",
            "awk -v redirect target": "f=/h/ruling.md; awk -v o=\"$f\" '{print > o}' /s/x",
            "awk -v literal target": "awk -v o=/h/x '{print > o}' /s/x",
            "awk print into a quoted handoff path": "awk '{print > \"/h/plan.md\"}' /s/x",
            "awk printf append": "awk '{printf \"%s\", $0 >> \"/h/plan.md\"}' /s/x",
            "awk print pipe": "awk '{print | \"sh\"}' /s/x",
            "awk getline command": "awk 'BEGIN{\"sh\" | getline x}'",
            "awk -f program file": "awk -f prog.awk /s/x",
            "awk computed program": "awk \"$P\" /s/x",
            "xargs into an unknown program": "echo /h/ruling.md | xargs mytool",
            "xargs -n1 into an unknown program": "ls /h/* | xargs -n1 mytool --in-place",
            "computed program bound to a writer": "C=touch; $C /h/ruling.md",
            "computed program bound twice": "C=cat; C=touch; $C /h/ruling.md",
            "computed program bound in an && branch": "false && C=cat; $C touch /h/ruling.md",
            "computed program bound in a group": "{ C=cat; }; $C /h/ruling.md",
            "computed program read into": "C=cat; read C; $C /h/ruling.md",
            "computed program default form": "C=cat; ${C:=touch} /h/ruling.md",
            "computed program bound inline": "C=cat $C /h/ruling.md",
        }
        for name, line in cases.items():
            w = self.writes(line)
            self.assertTrue(any(x["dir"] is None and x["name"] is None for x in w), (name, w))

    def test_r14_residual_pass_rows_write_nothing(self):
        for line in ("sed -n '1,5p' /h/ruling.md",
                     "sed -n '/review/p' /h/ruling.md",
                     "sed -n 's/new/wow/p' /h/ruling.md",
                     "sed -n -e '/^W/,/^E/p' -e '$=' /h/ruling.md",
                     "sed '/x/{s/a/b/g;p}' /h/ruling.md",
                     "sed '1i\\\nwe were here' /h/plan.md",
                     "C=cat; $C /h/ruling.md",
                     "C=head; \"$C\" -n 3 /h/ruling.md; ${C} /h/plan.md",
                     "awk '{print $1}' /h/plan.md",
                     "awk -F: '$1 > 5 {print $2}' /h/plan.md",
                     "echo /h/plan.md | xargs cat",
                     "sed -e 'a\\' -e 'w /h/x' /s/x"):  # sed joins the -e scripts: the second is the appended text
            self.assertEqual(self.writes(line), [], line)
        # the e/w/W commands and s flags are still fully computed writes
        for line in ("sed -n '/review/w /h/x' /s/x", "sed '/a/e date' /s/x", "sed 's/a/b/gw /h/x' /s/x", "sed '/a/{W /h/x\n}' /s/x",
                     "sed 's/a/b/;e date' /s/x", "sed 'y/abc/' /s/x", "sed 's/a/b/x' /s/x"):
            w = self.writes(line)
            self.assertTrue(any(x["dir"] is None and x["name"] is None for x in w), (line, w))

    @unittest.skipUnless(sys.platform == "win32", "native drive paths are win32 targets")
    def test_native_backslash_drive_paths_are_targets_on_win32(self):
        # quoted: the path itself; unquoted: bash escapes, but the native spelling is ALSO a candidate (fail closed)
        for line in ("echo A > 'D:\\x\\h\\ruling.md'", 'cp x "D:\\x\\h\\ruling.md"', "echo A > D:\\x\\h\\ruling.md",
                     "dd of=D:\\x\\h\\ruling.md", "node w.js D:\\x\\h\\ruling.md"):
            self.assertIn("D:\\x\\h\\ruling.md", [w["path"] for w in self.writes(line)], line)

    def test_unreadable_line_is_an_error(self):
        self.assertIsNotNone(sf.facts({"command": "echo 'open", "cwd": self.cwd})["error"])

    def test_script_main_prints_one_json_line(self):
        out = subprocess.run([sys.executable, "-E", "-s", str(ROOT / "scripts" / "shell_facts.py")],
                             input=json.dumps({"command": "echo A > /h/r", "cwd": self.cwd}), capture_output=True, text=True,
                             check=True).stdout
        self.assertEqual(json.loads(out)["writes"][0]["path"], "/h/r")


if __name__ == "__main__":
    unittest.main()
