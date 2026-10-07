"""shell_write_guard.py: decisions over command STRINGS only. Nothing here runs a command
from the table; the guard only parses them against a temp workspace."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "shell_write_guard.py"
sys.path.insert(0, str(ROOT / "scripts"))
import shell_write_guard as swg  # noqa: E402

# (command, expected kind or None). `WS` is replaced by the workspace root.
TABLE = [
    # bench shapes (the 2b foreman wrote project files this way)
    ("cd WS && python3 - <<'EOF'\np='internal/api/router.go'\ns=open(p).read()\ns=s.replace('a','b')\n"
     "open(p,'w').write(s)\nEOF", "python"),
    ("cd WS && cat > internal/api/cors_test.go <<'EOF'\npackage api\nEOF", "redirect"),
    # reads and writes outside the project
    ("cat f", None),
    ("grep x src/a.go > /dev/null", None),
    ("echo x > .workflow/n.md", None),
    ("cp a /tmp/b", None),
    ("cd .workflow && cat > n.md <<'EOF'\nnote\nEOF", None),
    ("go test ./... 2>&1 | tail -20", None),
    ("ls -la # a comment > x", None),
    ("echo 'a > b'", None),
    ("[[ 3 > 2 ]] && echo ok", None),
    ("(( i > 3 )) && echo ok", None),
    # redirections
    ("echo x > f", "redirect"),
    ("echo x >> f", "redirect"),
    ("echo x >| f", "redirect"),
    ("ls &> f", "redirect"),
    ("ls 2> err.txt", "redirect"),
    ("echo x>f", "redirect"),
    ("ls >&out.log", "redirect"),
    ("ls 2>&1 | head", None),
    ("ls >&2", None),
    # tee
    ("echo x | tee -a out.txt", "tee"),
    ("echo x | tee .workflow/x", None),
    # in-place editors
    ("sed -i 's/a/b/' src/x.go", "sed-i"),
    ("sed -i '' 's/a/b/' src/x.go", "sed-i"),
    ("sed --in-place=.bak -e s/a/b/ f", "sed-i"),
    ("sed -i '' 's/a/b/' .workflow/x", None),
    ("sed 's/a/b/' src/x.go", None),
    ("perl -pi -e 's/a/b/' f", "perl-i"),
    ("perl -lne 'print' f", None),
    ("ruby -i -pe 'x' f", "ruby-i"),
    # file utilities
    ("cp a src/b", "cp"),
    ("mv .workflow/a src/", "mv"),
    ("mv src/a /tmp/", "mv"),
    ("install -m 644 a src/b", "install"),
    ("ln -s x src/y", "ln"),
    ("rsync -a x/ src/", "rsync"),
    ("rsync -a src/ host:/x", None),
    ("touch src/new.go", "touch"),
    ("truncate -s 0 f", "truncate"),
    ("dd if=/dev/zero of=f bs=1 count=1", "dd"),
    ("dd if=f of=/tmp/x", None),
    # git and patch
    ("git apply x.diff", "git"),
    ("git apply --check x.diff", None),
    ("git am < x.mbox", "git"),
    ("git restore src/x", "git"),
    ("git checkout -- src/x", "git"),
    ("git checkout HEAD~1 -- src/x", "git"),
    ("git checkout -b feat", None),
    ("git stash pop", "git"),
    ("git stash apply", "git"),
    ("git stash list", None),
    ("git reset --hard", "git"),
    ("git reset HEAD~1", None),
    ("git -C /tmp/other reset --hard", None),
    ("patch -p1 < x.diff", "patch"),
    ("patch --dry-run -p1 < x.diff", None),
    # interpreter code
    ("python3 -c \"open('f','w').write('x')\"", "python"),
    ("python3 -c \"open('/tmp/f','w').write('x')\"", None),
    ("python3 -c \"print(open('f', encoding='ascii').read())\"", None),
    ("python3 <<'EOF'\nfrom pathlib import Path\nPath('src/a').write_text('x')\nEOF", "python"),
    ("python3 <<'EOF'\nfrom pathlib import Path\nPath('.workflow/a').write_text('x')\nEOF", None),
    ("printf \"open('f','w')\" | python3", "python"),
    ("node -e \"require('fs').writeFileSync('a.txt','x')\"", "node"),
    ("node -e \"require('fs').writeFileSync('.workflow/a.txt','x')\"", None),
    ("perl -e 'open(my $fh, \">\", \"f\"); print $fh 1'", "perl"),
    ("perl -e 'open(my $fh, \"<\", \"f\"); print <$fh>'", None),
    ("ruby -e 'File.write(\"f\", \"x\")'", "ruby"),
    ("sh -c 'echo x > f'", "redirect"),
    ("bash -c \"cd src && echo hi > x\"", "redirect"),
    ("sh -c 'echo x > /tmp/f'", None),
    ("eval \"echo x > f\"", "redirect"),
    # unresolvable targets count as writes
    ("echo x > $OUT", "redirect"),
    ("echo x > *.go", "redirect"),
    ("echo x > \"$(pwd)/f\"", "redirect"),
    ("cp a `echo b`", "cp"),
    ("cd $D && echo x > f", "redirect"),
    ("echo x 'unterminated", "unreadable"),
    # cd tracking and scoping
    ("(cd .workflow); echo x > f", "redirect"),
    ("(cd .workflow && echo x > f)", None),
    ("cd .workflow | true; echo x > f", "redirect"),
    ("cd .workflow && sed -i s/a/b/ ../src/x", "sed-i"),
    ("cd /tmp && echo x > f", None),
    ("cd /tmp; cd WS/src; echo x > f", "redirect"),
    # wrappers and nested commands
    ("find . -name '*.go' -exec sed -i s/a/b/ {} \\;", "sed-i"),
    ("ls | xargs sed -i s/a/b/", "sed-i"),
    ("sudo tee f < x", "tee"),
    ("env -C src touch x", "touch"),
    ("env -C /tmp touch x", None),
    ("echo $(echo x > f)", "redirect"),
]


class ShellWriteGuardTest(unittest.TestCase):
    def setUp(self):
        self.ws = os.path.realpath(tempfile.mkdtemp(prefix="pf-swg-"))
        for d in (".workflow", "src"):
            os.mkdir(os.path.join(self.ws, d))

    def tearDown(self):
        shutil.rmtree(self.ws, ignore_errors=True)

    def test_table(self):
        for command, kind in TABLE:
            cmd = command.replace("WS", self.ws)
            with self.subTest(command=command):
                hit = swg.decide(cmd, self.ws, self.ws)
                self.assertEqual(hit[0] if hit else None, kind, hit)

    def test_cwd_outside_workspace(self):
        other = os.path.realpath(tempfile.mkdtemp(prefix="pf-swg-out-"))
        try:
            self.assertIsNone(swg.decide("echo x > f; git reset --hard", other, self.ws))
            self.assertEqual(swg.decide("echo x > %s" % os.path.join(self.ws, "f").replace("\\", "/"), other, self.ws)[0], "redirect")
        finally:
            shutil.rmtree(other, ignore_errors=True)

    def test_windows_paths(self):
        if os.name == "nt":
            target = os.path.join(self.ws, "src", "x.go")
            self.assertEqual(swg.decide("cp a '%s'" % target, self.ws, self.ws)[0], "cp")
            msys = "/" + self.ws[0].lower() + self.ws[2:].replace("\\", "/")
            self.assertEqual(swg.decide("cd %s && echo x > f" % msys, "C:\\", self.ws)[0], "redirect")
        else:
            # a drive-letter path is never inside a POSIX workspace
            self.assertIsNone(swg.decide("cp a 'C:\\proj\\x.go'", self.ws, self.ws))

    def test_main_contract(self):
        def call(payload):
            return subprocess.run([sys.executable, "-E", "-s", str(SCRIPT)], input=payload.encode("utf-8"),
                                  capture_output=True, timeout=30)
        deny = call(json.dumps({"tool_name": "Bash", "tool_input": {"command": "echo x > f"}, "cwd": self.ws, "workspace": self.ws}))
        self.assertEqual(deny.returncode, 0)
        out = json.loads(deny.stdout.decode())
        self.assertEqual(out["kind"], "redirect")
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIn(swg.REFUSAL, out["hookSpecificOutput"]["permissionDecisionReason"])
        allow = call(json.dumps({"tool_name": "Bash", "tool_input": {"command": "echo x > .workflow/n.md"}, "cwd": self.ws, "workspace": self.ws}))
        self.assertEqual((allow.returncode, allow.stdout), (0, b""))
        broken = call("[1, 2]")
        self.assertEqual((broken.returncode, broken.stdout), (2, b""))
        self.assertIn(b"internal error", broken.stderr)


if __name__ == "__main__":
    unittest.main()
