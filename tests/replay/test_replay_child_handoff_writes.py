"""Replay: a session that is the child side of a handoff dir (PI_FOREMAN_HANDOFF_DIR, no subagent) writes `result.md` by shell redirect, by `cp` and by
the write tool, with nobody at its pane: no dialog, no refusal, and the file arrives. A name that is not child-written stays refused.

Run:  python -m unittest discover -s tests/replay -v
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

CHILD = "fm-demo-abc123"


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestChildHandoffWrites(ReplayCase):
    def test_result_md_by_redirect_cp_and_write_tool(self):
        rig = self.rig("hwrites", {"foreman": {}}, config={"sync": {"runRetro": False}}, permissions="baseline")
        handoff = rig.root / "handoff"
        handoff.mkdir()
        (handoff / "parent").write_text("parent-x\n", "utf-8")
        (rig.project / "notes.txt").write_bytes(b"hello\n")
        h = handoff.as_posix()
        calls = [
            ("bash", {"command": "cat notes.txt > %s/result.md" % h}),
            ("bash", {"command": "cp notes.txt %s/ask.md" % h}),
            ("write", {"path": str(handoff / "plan.md"), "content": "# Plan\n"}),
            ("bash", {"command": "cp notes.txt %s/ruling.md" % h}),
        ]
        rig.script.write_text(json.dumps({"foreman": {"c1": [{"tools": [{"name": n, "arguments": a}]} for n, a in calls] + [{"text": "done"}]}}), "utf-8")
        pi = rig.start(env={"PI_FOREMAN_HANDOFF_DIR": str(handoff), "PI_INTERCOM_STABLE_ID": CHILD})
        pi.session_id()
        res = tool_results(pi.prompt("[[replay:c1]] go", timeout=120))
        pi.close()
        self.assertEqual([(n, e) for n, e, _ in res[:3]], [("bash", False), ("bash", False), ("write", False)], res)
        self.assertEqual((handoff / "result.md").read_bytes(), b"hello\n")
        self.assertEqual((handoff / "ask.md").read_bytes(), b"hello\n")
        self.assertEqual((handoff / "plan.md").read_text("utf-8"), "# Plan\n")
        # a parent-written name is no child-written name
        self.assertFalse((handoff / "ruling.md").exists(), res)


if __name__ == "__main__":
    unittest.main()
