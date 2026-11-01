"""Replay: builder launches that are NOT a climbing revision (ladder item 3, negative cases).

Same config as test_replay_ladder_fail_climb.py. Each case is one fixture:
- ladder_builder_after_pass: a fresh builder after a reviewer PASS: no `revision` event, no climb.
- ladder_two_builders_phase: after a FAIL, the second builder in the prompt names another phase (P2):
  a new round chain, so it is not the same-prompt revision (no second `revision` event, no climb).
- ladder_builder_keyword: after a FAIL, a builder with an explicit model keyword: `revision` decision
  `keyword`, no climb.
Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402
from test_replay_ladder_fail_climb import CONFIG  # noqa: E402
from test_replay_review_flow import usage  # noqa: E402


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestLadderRevisionNegative(ReplayCase):
    def run_case(self, name, notices):
        rig = self.rig(name.replace("_", "-"), load_fixture(name), config=CONFIG)
        (rig.project / "a.txt").write_text("alpha\n", "utf-8")
        pi = rig.start()
        sid = pi.session_id()
        pi.prompt("[[replay:c1]] build it", timeout=60)
        for _ in range(notices):
            pi.wait_child_notify(timeout=180)
        pi.drain(20)
        pi.close()
        safe = "".join(c for c in sid if c.isalnum() or c in "-_")
        trace = rig.traces()["trace-" + safe]
        builders = [(x["kind"], x["model"]) for x in usage(rig, sid) if x["role"] == "builder"]
        revs = [(r["decision"], r["reason"]) for r in trace if r.get("event") == "revision" and r.get("decision") in ("climb", "unchanged", "no_strong", "keyword")]
        rungs = [r for r in trace if r.get("event") in ("rung_up", "rung_top")]
        return builders, revs, rungs

    def test_builder_after_pass_does_not_climb(self):
        builders, revs, rungs = self.run_case("ladder_builder_after_pass", 3)
        self.assertEqual(revs, [])
        self.assertEqual(rungs, [])
        self.assertEqual(builders, [("first", "builder"), ("first", "builder")])

    def test_second_builder_naming_another_phase_does_not_climb(self):
        builders, revs, rungs = self.run_case("ladder_two_builders_phase", 4)
        self.assertEqual(revs, [("climb", "review_fail")])  # only the first builder is a revision
        self.assertEqual([r["event"] for r in rungs], ["rung_up"])
        self.assertEqual(builders[:2], [("first", "builder"), ("strong-relaunch", "finalizer")])
        self.assertEqual(builders[2][1], "builder")  # the P2 builder stays on the bottom rung

    def test_explicit_keyword_after_fail_traces_keyword_and_does_not_climb(self):
        builders, revs, rungs = self.run_case("ladder_builder_keyword", 4)
        self.assertEqual(revs, [("keyword", "review_fail")])
        self.assertEqual([r["event"] for r in rungs if r.get("reason") == "review_fail"], [])
        self.assertEqual([m for _, m in builders], ["builder", "builder"])


if __name__ == "__main__":
    unittest.main()
