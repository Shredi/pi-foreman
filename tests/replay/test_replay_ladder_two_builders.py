"""Replay: two separate builder launches after one reviewer FAIL both climb (ladder item 3).

Same config as test_replay_ladder_fail_climb.py. After the FAIL the foreman launches two builders in
the same prompt as two separate `subagent` calls. The first is the revision round (one round used);
the second answers the same FAIL, so it is a strong-relaunch too (usage kind `strong-relaunch`; the
ladder sees the live rung already strong: `rung_top` reason `review_fail`) and does not use a second
round. Every revision launch traces `revision`: `climb`, then `unchanged`.
Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import PROVIDER_A, load_fixture  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402
from test_replay_ladder_fail_climb import CONFIG  # noqa: E402
from test_replay_review_flow import usage  # noqa: E402


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestLadderTwoBuilders(ReplayCase):
    def test_second_builder_after_fail_climbs_without_a_second_round(self):
        rig = self.rig("ladder-two-builders", load_fixture("ladder_two_builders"), config=CONFIG)
        (rig.project / "a.txt").write_text("alpha\n", "utf-8")
        pi = rig.start()
        sid = pi.session_id()
        recs = pi.prompt("[[replay:c1]] build it", timeout=60)
        for _ in range(4):
            recs += pi.wait_child_notify(timeout=180)[1]
        recs += pi.drain(20)  # a fifth notice may have been folded into an earlier one
        pi.close()

        safe = "".join(c for c in sid if c.isalnum() or c in "-_")
        trace = rig.traces()["trace-" + safe]
        rungs = [(r["event"], r["role"], r.get("to") or r.get("model"), r["reason"]) for r in trace if r.get("event") in ("rung_up", "rung_top")]
        self.assertEqual(rungs, [("rung_up", "builder", "%s/finalizer" % PROVIDER_A, "review_fail"),
                                 ("rung_top", "builder", "%s/finalizer" % PROVIDER_A, "review_fail")])  # the second is already on the live strong rung
        builders = [(x["kind"], x["model"]) for x in usage(rig, sid) if x["role"] == "builder"]
        self.assertEqual(builders, [("first", "builder"), ("strong-relaunch", "finalizer"), ("strong-relaunch", "finalizer")])
        revs = [r for r in trace if r.get("event") == "revision" and r.get("decision") in ("climb", "unchanged", "no_strong", "keyword")]
        self.assertEqual([(r["decision"], r["reason"]) for r in revs], [("climb", "review_fail"), ("unchanged", "review_fail")])
        used = [r for r in trace if r.get("event") == "revision" and r.get("decision") in ("revision", "strong-relaunch")]
        self.assertEqual(len(used), 1, used)  # one revision round counted


if __name__ == "__main__":
    unittest.main()
