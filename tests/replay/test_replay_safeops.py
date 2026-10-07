"""Replay: foreman_move through the real Pi tool path (design section 5, precondition ops).

The foreman triages trivial first (the triage gate, plan D10, refuses its own workspace writes
otherwise). One move passes every precondition and runs without approval; the second targets the file the
first one created, fails `dst_exists` and changes nothing. The trace records `safe_op` with the
precondition name only, never a path. Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, shape, tool_results  # noqa: E402
from test_replay import ReplayCase  # noqa: E402

KEYS = ("event", "role", "toolFamily", "guard", "decision", "model", "tier", "exit", "precondition")


class TestSafeOps(ReplayCase):
    def test_move_runs_then_refuses_existing_destination(self):
        # Two new scratch files at trivial: above the default bound (newFiles 0), so it is raised here.
        rig = self.rig("safeops", load_fixture("safe_ops"), config={"ceremony": {"trivialBound": {"files": 3, "newFiles": 2}}})
        pi = rig.start()
        sid = pi.session_id()
        recs = pi.prompt("[[replay:s1]] start", timeout=60)
        asks = [r for r in recs if r.get("type") == "extension_ui_request" and r.get("method") in ("confirm", "select")]
        self.assertEqual(asks, [], "a precondition-checked op must not ask")
        res = tool_results(recs, "foreman_move")
        self.assertEqual([e for _, e, _ in res], [False, True], res)
        self.assertIn("foreman_move: done.", res[0][2])
        self.assertIn("precondition failed: dst_exists", res[1][2])
        pi.close()
        self.assertEqual((rig.project / "b.txt").read_text("utf-8"), "alpha\n")
        self.assertEqual((rig.project / "c.txt").read_text("utf-8"), "gamma\n")
        self.assertFalse((rig.project / "a.txt").exists())
        trace = rig.traces()["trace-" + sid]
        ops = [r for r in trace if r.get("event") == "safe_op"]
        self.assertEqual(shape(ops, KEYS), [
            {"event": "safe_op", "toolFamily": "move", "decision": "ran"},
            {"event": "safe_op", "toolFamily": "move", "decision": "precondition_failed", "precondition": "dst_exists"},
        ])
        self.assertNotIn("b.txt", json.dumps(trace))
        self.golden("safe_ops", {"session": shape(trace, KEYS)})


if __name__ == "__main__":
    unittest.main()
