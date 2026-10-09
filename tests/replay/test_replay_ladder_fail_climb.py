"""Replay: the builder climbs on the first reviewer FAIL (ladder.strongOnRevision, go-d shape).

The builder maps `foreman-fake/builder` (bottom) -> strong `foreman-fake/finalizer`; L1 sets
ladder.strongOnRevision true. Builder on the bottom rung -> reviewer FAIL -> two finish attempts are
refused with the climb hint and do not count (`finish_refused {climb_available}`, no
`ceremony_incomplete`) -> the revision builder, launched without a model, runs on the strong rung
(`rung_up` reason `review_fail`, usage kind `strong-relaunch`) -> re-review FAIL on the top rung ->
the two-refusal valve ends with `ceremony_incomplete` as before.
Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import PROVIDER_A, load_fixture  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402
from test_replay_ceremony_gate import gate_messages  # noqa: E402
from test_replay_review_flow import usage  # noqa: E402

CONFIG = {"providers": {PROVIDER_A: {"roles": {"builder": {"strong": {"model": "%s/finalizer" % PROVIDER_A}}}}}}
HINT = "Relaunch the builder for the revision; it climbs to its strong rung."


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestLadderFailClimb(ReplayCase):
    def test_fail_climbs_and_valve_waits_for_the_top_rung(self):
        rig = self.rig("ladder-fail-climb", load_fixture("ladder_fail_climb"), config=CONFIG)
        (rig.project / "a.txt").write_text("alpha\n", "utf-8")
        pi = rig.start()
        sid = pi.session_id()
        recs = pi.prompt("[[replay:c1]] build it", timeout=60)
        for _ in range(4):
            recs += pi.wait_child_notify(timeout=180)[1]
        pi.close()

        msgs = gate_messages(recs)
        self.assertEqual(len(msgs), 4, msgs)
        self.assertTrue(all(HINT in m for m in msgs[:2]), msgs)
        self.assertTrue(all(HINT not in m and "last verdict FAIL" in m for m in msgs[2:]), msgs)

        safe = "".join(c for c in sid if c.isalnum() or c in "-_")
        trace = rig.traces()["trace-" + safe]
        kinds = [r["event"] for r in trace if r.get("event") in ("finish_refused", "rung_up", "ceremony_incomplete")]
        self.assertEqual(kinds, ["finish_refused", "finish_refused", "rung_up", "finish_refused", "finish_refused", "ceremony_incomplete"])
        refused = [r for r in trace if r.get("event") == "finish_refused"]
        self.assertEqual([r.get("climb_available") for r in refused], [True, True, None, None])
        self.assertEqual([r["missing"] for r in refused], ["reviewer"] * 4)
        [rung] = [r for r in trace if r.get("event") == "rung_up"]
        self.assertEqual((rung["role"], rung["from"], rung["to"], rung["reason"]),
                         ("builder", "%s/builder" % PROVIDER_A, "%s/finalizer" % PROVIDER_A, "review_fail"))
        self.assertEqual([r["reason"] for r in trace if r.get("event") == "launch_refused"], [])
        builders = [(x["kind"], x["model"]) for x in usage(rig, sid) if x["role"] == "builder"]
        self.assertEqual(builders, [("first", "builder"), ("strong-relaunch", "finalizer")])


if __name__ == "__main__":
    unittest.main()
