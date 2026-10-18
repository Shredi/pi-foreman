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

    def test_unreadable_line_is_an_error(self):
        self.assertIsNotNone(sf.facts({"command": "echo 'open", "cwd": self.cwd})["error"])

    def test_script_main_prints_one_json_line(self):
        out = subprocess.run([sys.executable, "-E", "-s", str(ROOT / "scripts" / "shell_facts.py")],
                             input=json.dumps({"command": "echo A > /h/r", "cwd": self.cwd}), capture_output=True, text=True,
                             check=True).stdout
        self.assertEqual(json.loads(out)["writes"][0]["path"], "/h/r")


if __name__ == "__main__":
    unittest.main()
