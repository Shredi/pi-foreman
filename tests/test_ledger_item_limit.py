import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "core" / "scripts"


def run_ledger(path, *args):
    return subprocess.run([sys.executable, "-I", str(SCRIPTS / "ledger.py"), "-f", str(path), *args],
                          capture_output=True, text=True)


def run_guard(file_path, content):
    env = dict(os.environ, FABLE_ORCH_METRICS="0")
    env.pop("LEDGER_WRITE_GUARD", None)
    env.pop("FABLE_ORCH_MODE", None)
    data = {"session_id": "none-such-limit-test", "tool_input": {"file_path": str(file_path), "content": content}}
    r = subprocess.run([sys.executable, "-I", str(SCRIPTS / "ledger_guard_write.py")],
                       input=json.dumps(data), capture_output=True, text=True, env=env)
    return json.loads(r.stdout) if r.stdout.strip() else None


class ItemLimitTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name) / ".workflow"
        self.dir.mkdir()
        self.path = self.dir / "LEDGER-x.md"
        self.path.write_text("- [ ] 1. short\n- [ ] V. verify\n", encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_note_over_limit_refused(self):
        r = run_ledger(self.path, "note", "1", "n" * 1000)
        self.assertEqual(r.returncode, 1)
        self.assertIn("keep evidence in a file and link it", r.stderr)
        self.assertIn("short\n", self.path.read_text(encoding="utf-8"))

    def test_add_and_mark_note_over_limit_refused(self):
        self.assertEqual(run_ledger(self.path, "add", "a" * 1000).returncode, 1)
        self.assertEqual(run_ledger(self.path, "mark", "1", "m" * 1000).returncode, 1)

    def test_note_within_limit_passes(self):
        self.assertEqual(run_ledger(self.path, "note", "1", "n" * 100).returncode, 0)

    def test_write_guard_refuses_growth_only(self):
        # a new over-limit line is refused, even with no marker (the limit is not a binding matter)
        deny = run_guard(self.path, "- [ ] 1. " + "w" * 1100 + "\n")
        self.assertIsNotNone(deny)
        self.assertIn("keep evidence in a file and link it", deny["hookSpecificOutput"]["permissionDecisionReason"])
        # an item already over the limit: a checkbox flip passes, growth does not
        long_line = "- [ ] 1. " + "w" * 1100
        self.path.write_text(long_line + "\n", encoding="utf-8")
        self.assertIsNone(run_guard(self.path, long_line.replace("[ ]", "[x]") + "\n"))
        self.assertIsNotNone(run_guard(self.path, long_line + "more\n"))

    def test_write_guard_ignores_other_files(self):
        other = self.dir / "notes.md"
        self.assertIsNone(run_guard(other, "- [ ] 1. " + "w" * 1100 + "\n"))


if __name__ == "__main__":
    unittest.main()
