"""Replay: role ladder (rung_up) on the fake provider.

The builder maps `foreman-fake/builder` -> strong `foreman-fake/senior-reviewer`, strongAbove 1000.
A strong launch without a reason or trigger is refused. The bottom-rung builder's first call
reports 2000 input tokens: its adapter steers it once, and it answers with a `RUNG_UP: context`
handoff report. The held launch result carries the climb hint; the foreman's strong relaunch
passes with no reason, gets the handoff prepended to its task, and the trace records `rung_up`.
Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

CONFIG = {
    "ceremony": {"launchWait": "block"},
    "providers": {"foreman-fake": {"strongAbove": 1000, "roles": {"builder": {"strong": {"model": "foreman-fake/senior-reviewer"}}}}},
}
HANDOFF = "[pi-foreman rung-up handoff] The previous builder run"


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestLadder(ReplayCase):
    def test_context_trigger_handoff_strong_relaunch(self):
        rig = self.rig("ladder", load_fixture("ladder"), config=CONFIG)
        pi = rig.start()
        sid = pi.session_id()
        res = tool_results(pi.prompt("[[replay:lad]] fix item 1", timeout=240))
        pi.close()
        self.assertEqual([(n, e) for n, e, _ in res], [("subagent", True), ("subagent", False), ("subagent", False)])
        self.assertIn("strong_no_reason", res[0][2])
        self.assertIn("RUNG_UP: context", res[1][2])
        self.assertIn("ended climb-eligible (context)", res[1][2])
        self.assertIn("child: finished on the strong rung", res[2][2])

        safe = "".join(c for c in sid if c.isalnum() or c in "-_")
        traces = rig.traces()
        foreman = traces["trace-" + safe]
        refused = [r for r in foreman if r.get("event") == "launch_refused"]
        self.assertEqual([r.get("reason") for r in refused], ["strong_no_reason"])
        rung = [r for r in foreman if r.get("event") == "rung_up"]
        self.assertEqual([(r["role"], r["from"], r["to"], r["reason"]) for r in rung],
                         [("builder", "foreman-fake/builder", "foreman-fake/senior-reviewer", "context")])
        steers = [r for recs in traces.values() for r in recs if r.get("event") == "rung_up_steer"]
        self.assertEqual([(r["role"], r["count"], r["rung"]) for r in steers], [("builder", 2006, "bottom")])
        # The strong child's session holds its task with the handoff (report so far) prepended.
        hits = [f for f in rig.root.rglob("*.jsonl") if HANDOFF in f.read_text("utf-8", "replace") and "Remaining: the tests" in f.read_text("utf-8", "replace")]
        self.assertTrue(hits, "no session file carries the handoff")


if __name__ == "__main__":
    unittest.main()
