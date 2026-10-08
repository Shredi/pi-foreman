"""Replay: one review per revision (ceremony.reviewPerRevision), heavy threshold (ceremony.heavyThreshold)
and the child tier fix, on the fake provider.

After a reviewer PASS with nothing revised, a second reviewer launch is refused (trace
review_dup_refused) unless its task carries [second-opinion] (trace review_second_opinion). A
builder revision or a FAIL lets the reviewer launch again; reviewPerRevision false never refuses.
heavyThreshold strict: a heavySignals keyword in the request is only a triage_hint, eee843d still
escalates to heavy. A child never traces a tier event, whatever its task says.
Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results, trace_of  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402
from test_replay_ceremony_gate import events  # noqa: E402
from test_replay_review_gate import notifies  # noqa: E402


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestDupReview(ReplayCase):
    def flow(self, tag, key, n, config=None):
        rig = self.rig("dr-" + tag, load_fixture("dup_review"), config=config)
        pi = rig.start()
        sid = pi.session_id()
        recs = pi.prompt("[[replay:%s]] build it" % key, timeout=60)
        recs += notifies(pi, n)
        pi.close()
        return rig, sid, recs

    def test_second_reviewer_after_pass_is_refused(self):
        rig, sid, recs = self.flow("dup", "d1", 2)
        launches = [(n, e) for n, e, _ in tool_results(recs) if n == "subagent"]
        self.assertEqual(launches, [("subagent", False)] * 2 + [("subagent", True)], tool_results(recs))
        self.assertEqual([r["agent"] for r in events(rig, sid, "review_dup_refused")], ["reviewer"])
        self.assertEqual(events(rig, sid, "review_second_opinion"), [])

    def test_second_opinion_marker_launches(self):
        rig, sid, recs = self.flow("so", "s1", 3)
        launches = [(n, e) for n, e, _ in tool_results(recs) if n == "subagent"]
        self.assertEqual(launches, [("subagent", False)] * 3, tool_results(recs))
        self.assertEqual(events(rig, sid, "review_dup_refused"), [])
        self.assertEqual([r["agent"] for r in events(rig, sid, "review_second_opinion")], ["reviewer"])

    def test_builder_revision_reopens_the_review(self):
        rig, sid, recs = self.flow("rev", "r1", 4)
        launches = [(n, e) for n, e, _ in tool_results(recs) if n == "subagent"]
        self.assertEqual(launches, [("subagent", False)] * 4, tool_results(recs))
        self.assertEqual(events(rig, sid, "review_dup_refused"), [])
        self.assertEqual(events(rig, sid, "review_second_opinion"), [])

    def test_fail_reopens_the_review(self):
        rig, sid, recs = self.flow("fail", "x1", 3)
        launches = [(n, e) for n, e, _ in tool_results(recs) if n == "subagent"]
        self.assertEqual(launches, [("subagent", False)] * 3, tool_results(recs))
        self.assertEqual(events(rig, sid, "review_dup_refused"), [])

    def test_knob_false_never_refuses(self):
        rig, sid, recs = self.flow("off", "d1", 3, config={"ceremony": {"reviewPerRevision": False}})
        launches = [(n, e) for n, e, _ in tool_results(recs) if n == "subagent"]
        self.assertEqual(launches, [("subagent", False)] * 3, tool_results(recs))
        self.assertEqual(events(rig, sid, "review_dup_refused"), [])
        self.assertEqual(events(rig, sid, "review_second_opinion"), [])


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestHeavyThreshold(ReplayCase):
    def prompt(self, tag, config=None):
        rig = self.rig("ht-" + tag, load_fixture("dup_review"), config=config)
        pi = rig.start()
        sid = pi.session_id()
        pi.prompt("[[replay:h1]] fix the ci flake", timeout=60)
        pi.close()
        return rig, sid

    def test_strict_keyword_is_a_hint_not_an_escalation(self):
        rig, sid = self.prompt("strict")
        self.assertEqual(events(rig, sid, "tier"), [])
        self.assertEqual([r["signals"] for r in events(rig, sid, "triage_hint")], ["ci"])

    def test_eee843d_escalates_as_before(self):
        rig, sid = self.prompt("old", {"ceremony": {"heavyThreshold": "eee843d"}})
        self.assertEqual([r["tier"] for r in events(rig, sid, "tier")], ["heavy"])
        self.assertEqual(events(rig, sid, "triage_hint"), [])

    def test_child_task_keyword_emits_no_tier_event(self):
        for tag, config in (("child-strict", None), ("child-old", {"ceremony": {"heavyThreshold": "eee843d"}})):
            rig = self.rig("ht-" + tag, load_fixture("dup_review"), config=config)
            pi = rig.start()
            pi.prompt("[[replay:c1]] build it", timeout=60)
            notifies(pi, 1)
            pi.close()
            child = trace_of(rig.traces(), "child")
            self.assertIsNotNone(child, tag)
            self.assertEqual([r for r in child if r.get("event") == "tier"], [], tag)


if __name__ == "__main__":
    unittest.main()
