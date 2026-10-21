import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "core" / "scripts"))
import ledger_bind as lb  # noqa: E402


class LedgerBindTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        self.wf = self.tmp / "proj" / ".workflow"
        self.wf.mkdir(parents=True)
        self.todo = self.wf / "LEDGER-todo.md"
        self.r24 = self.wf / "LEDGER-r24.md"
        for f in (self.todo, self.r24):
            f.write_text("# ledger\n")
        patches = [
            mock.patch.object(tempfile, "gettempdir", return_value=str(self.tmp)),
            mock.patch.dict(os.environ, {"FABLE_ORCH_SESSION_BINDING": "1"}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.marker = Path(lb.session_marker_path("s1"))

    def bound(self):
        return json.loads(self.marker.read_text()).get("ledger") if self.marker.exists() else None

    def hit(self, tool, path):
        lb._bind({"tool_name": tool, "session_id": "s1", "tool_input": {"file_path": str(path)}, "tool_response": {}})

    def test_write_rebinds_edit_keeps_live_binding(self):
        self.hit("Write", self.todo)
        self.assertEqual(self.bound(), str(self.todo))
        self.hit("Write", self.r24)
        self.assertEqual(self.bound(), str(self.r24))
        self.hit("Edit", self.todo)
        self.hit("MultiEdit", self.todo)
        self.assertEqual(self.bound(), str(self.r24))
        self.hit("Write", self.todo)
        self.assertEqual(self.bound(), str(self.todo))

    def test_edit_binds_when_unbound_or_bound_file_is_gone(self):
        self.hit("Edit", self.todo)
        self.assertEqual(self.bound(), str(self.todo))
        self.todo.unlink()
        self.hit("Edit", self.r24)
        self.assertEqual(self.bound(), str(self.r24))

    def test_bash_ledger_f_keeps_live_binding(self):
        self.hit("Write", self.r24)
        lb._bind({"tool_name": "Bash", "session_id": "s1", "cwd": str(self.tmp),
                  "tool_input": {"command": f"ledger mark 1 -f {self.todo}"}, "tool_response": {}})
        self.assertEqual(self.bound(), str(self.r24))


if __name__ == "__main__":
    unittest.main()
