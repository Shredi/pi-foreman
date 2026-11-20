"""Replay: structured review verdicts (docs/review.md, `review_verdict`) on the fake provider.

Finding 78: a reviewer's report text that quotes `VERDICT: FAIL` is no verdict; its `pass` record is. The normal PASS
stands, so the foreman's `[high-stakes]` launch is allowed (it is refused as `high_stakes_early` when no PASS stands).
Finding 19: a launch with `items: [1, 4, 6]` takes only those ids: a verdict call naming item 2 is refused in the
reviewer's turn, and the call with 1, 4 and 6 marks exactly those items in the bound ledger.
Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import PROVIDER_A, load_fixture, tool_results
from test_replay import REASON, ReplayCase
from test_replay_ceremony_gate import events

HIGH_STAKES = {"ceremony": {"highStakes": {"model": PROVIDER_A + "/senior-reviewer"}}}


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestReviewVerdict(ReplayCase):
    def test_quoted_fail_text_with_a_pass_record_is_a_pass_and_high_stakes_is_allowed(self):
        rig = self.rig("rv-78", load_fixture("review_verdict"), config=HIGH_STAKES)
        pi = rig.start()
        sid = pi.session_id()
        recs = pi.prompt("[[replay:q1]] build it", timeout=60)
        _, notice_recs = pi.wait_child_notify(timeout=180)
        notice, reviewed = pi.wait_child_notify(timeout=180)
        recs += notice_recs + reviewed
        self.assertIn("VERDICT: FAIL", notice, "the report text quotes the old verdict")
        _, hs = pi.wait_child_notify(timeout=180)
        pi.close()
        self.assertEqual(events(rig, sid, "review_high_stakes_refused"), [])
        launches = [(r["role"], r.get("occasion")) for r in events(rig, sid, "role_launch") if r["role"] == "reviewer"]
        self.assertEqual(launches, [("reviewer", "item"), ("reviewer", "high-stakes")], launches)
        ledger = (rig.project / ".workflow" / "LEDGER-qa.md").read_text("utf-8")
        self.assertIn("- [x] 1. synthetic item", ledger)
        launched = tool_results(recs + hs, "subagent")
        self.assertEqual([e for _, e, _ in launched], [False, False, False], launched)
        self.assertIn("occasion: high-stakes", launched[-1][2])

    def test_launch_items_limit_the_verdict_call_and_mark_exactly_those(self):
        rig = self.rig("rv-19", load_fixture("review_verdict"))
        pi = rig.start()
        sid = pi.session_id()
        pi.prompt("[[replay:i1]] build it", timeout=60)
        pi.wait_child_notify(timeout=180)
        pi.wait_child_notify(timeout=180)
        pi.close()
        ledger = (rig.project / ".workflow" / "LEDGER-qi.md").read_text("utf-8")
        for n in (1, 4, 6):
            self.assertRegex(ledger, r"- \[x\] %d\. " % n)
        for n in (2, 3, 5):
            self.assertRegex(ledger, r"- \[ \] %d\. " % n)
        self.assertIn("- [ ] V.", ledger)
        self.assertEqual([r["items"] for r in events(rig, sid, "ledger_mark_by_review")], ["1,4,6"])
        # the refusal of the id 2 call is the child's tool result, read from its session file
        sessions = [f.read_text("utf-8", "replace") for f in (rig.agent / "sessions").rglob("*.jsonl")]
        self.assertTrue(any("item 2 is not one of this launch's items" in text for text in sessions), "no refusal of item 2 in any session")


if __name__ == "__main__":
    unittest.main()
