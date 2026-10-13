"""git_guard.py: `-c` overrides that make git run a program are denied in main AND child mode;
a PATH prefix before git asks; a child may not write files from heredocs or stdin scripts
(R5 P2 S1). Decisions over command STRINGS only; every guarded literal here is a fixture string."""
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import git_guard as gg  # noqa: E402

EXEC_OVERRIDES = [
    "git -c core.hooksPath=/x status",
    "git -c core.hookspath=/x status",
    "git -c CORE.HOOKSPATH=/x status",
    "git -c alias.x='!sh -c id' x",
    "git -c ALIAS.x=!id x",
    "git -c core.fsmonitor=/x/hook status",
    "git -c core.fsMonitor=true status",
    "git -c diff.external=/x/prog diff",
    "git -c Diff.External=true diff",
]

CHILD_WRITES = [
    "python3 - <<'EOF'\nopen('f.txt', 'w').write('x')\nEOF",
    "python3 - <<EOF\nwith open(p, \"a\") as h:\n    h.write('x')\nEOF",
    "python - <<'EOF'\nopen('f', 'x')\nEOF",
    "python3 - <<'EOF'\nPath('f').write_text('x')\nEOF",
    "python3 -c \"open('f', 'w').write('x')\"",
    "echo \"open('f','w')\" | python3 -",
    "python3 - <<< \"open('f','wb')\"",
    "node -e \"require('fs').writeFileSync('f', 'x')\"",
    "node - <<'EOF'\nfs.appendFileSync('f', 'x')\nEOF",
    "node - <<'EOF'\nfs.writeSync(fd, 'x')\nEOF",
    "cat > f.txt <<'EOF'\nhello\nEOF",
    "cat >> f.txt <<EOF\nhello\nEOF",
    "cat <<EOF > f.txt\nhello\nEOF",
    "tee f.txt <<'EOF'\nhello\nEOF",
    "cat <<'EOF' | tee f.txt\nhello\nEOF",
]

CHILD_READS = [
    "python3 - <<'EOF'\nprint('hi')\nEOF",
    "python3 - <<'EOF'\nimport json\nprint(json.load(open('p.json')))\nEOF",
    "python3 - <<'EOF'\nprint(open('p', 'r').read())\nEOF",
    "python3 -c \"print(open('p').read())\"",
    "node -e \"console.log(require('fs').readFileSync('p', 'utf8'))\"",
    "cat <<'EOF'\nhello\nEOF",
    "cat f.txt",
    "cat f.txt > /dev/null",
]


@unittest.skipIf(shutil.which("git") is None, "git not on PATH")
class MainExecKeysTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="pf-gg-exec-")
        subprocess.run(["git", "init", "-q", cls.tmp], check=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def decide(self, cmd, mode):
        return gg.decide(cmd, mode, cwd=self.tmp)

    def test_exec_overrides_denied_with_reason(self):
        for cmd in EXEC_OVERRIDES:
            for mode in ("main", "child"):
                with self.subTest(cmd=cmd, mode=mode):
                    d = self.decide(cmd, mode)
                    self.assertEqual(d.level, gg.DENY)
                    self.assertTrue(d.reason)

    def test_benign_override_allowed(self):
        for mode in ("main", "child"):
            with self.subTest(mode=mode):
                self.assertEqual(self.decide("git -c user.name=x status", mode).level, gg.ALLOW)

    def test_path_prefix_asks(self):
        for cmd in ("PATH=/x git status", "env PATH=/x git status"):
            for mode in ("main", "child"):
                with self.subTest(cmd=cmd, mode=mode):
                    d = self.decide(cmd, mode)
                    self.assertEqual(d.level, gg.ASK)
                    self.assertIn("PATH", d.reason)

    def test_child_stdin_writes_denied(self):
        for cmd in CHILD_WRITES:
            with self.subTest(cmd=cmd):
                d = self.decide(cmd, "child")
                self.assertEqual(d.level, gg.DENY)
                self.assertIn("child rule: edit with the edit tool, never heredoc or stdin-script file writes", d.reason)

    def test_child_read_only_scripts_pass(self):
        for cmd in CHILD_READS:
            with self.subTest(cmd=cmd):
                self.assertEqual(self.decide(cmd, "child").level, gg.ALLOW)

    def test_main_not_affected_by_child_write_rule(self):
        self.assertEqual(self.decide("cat > f.txt <<'EOF'\nhello\nEOF", "main").level, gg.ALLOW)


if __name__ == "__main__":
    unittest.main()
