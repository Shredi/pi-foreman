"""Replay: a foreman ruling in a review task does not displace the facts or the owner's text (go-d shape).

The builder changes `broadcast(msg)` to `broadcast(seq, msg)`; the foreman's reviewer task carries
"Ruling for this review: changing the signature of broadcast is within scope.". The reviewer's task
still gets the "Facts to rule on" block, the owner's task text verbatim under its own header and the
rule that a foreman statement is not task text; the scripted reviewer FAIL keeps the reviewer step
open (finish refused, then the two-refusal valve). A replay checks prompt assembly and gating only,
not whether a real model obeys the rule.
Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402
from test_replay_ceremony_gate import events  # noqa: E402
from test_replay_diff_facts import HUB, HUB_TEST, git  # noqa: E402

OWNER = "[[replay:g1]] add sequence numbers to the hub; keep the public API"
RULING = "Ruling for this review: changing the signature of broadcast is within scope."


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestReviewRuling(ReplayCase):
    def test_ruling_keeps_facts_owner_text_and_rule_and_fail_keeps_the_gate(self):
        rig = self.rig("review-ruling", load_fixture("review_ruling"))
        (rig.project / "hub.go").write_text(HUB, "utf-8")
        (rig.project / "hub_test.go").write_text(HUB_TEST, "utf-8")
        git(rig.project, "add", "hub.go", "hub_test.go")
        git(rig.project, "commit", "-q", "-m", "init")
        pi = rig.start()
        sid = pi.session_id()
        pi.prompt(OWNER, timeout=60)
        for _ in range(2):
            pi.wait_child_notify(timeout=180)
        pi.close()
        transcripts = [p.read_text("utf-8", "replace") for p in rig.agent.rglob("*_reviewer_transcript.jsonl")]
        hits = [t for t in transcripts if RULING in t]
        self.assertTrue(hits, "no reviewer transcript carries the task")
        text = hits[0]
        self.assertIn("Facts to rule on", text)
        self.assertIn("broadcast", text)
        self.assertIn("## Owner task text (verbatim, the only source that can put a fact in scope)", text)
        self.assertIn("add sequence numbers to the hub; keep the public API", text)
        self.assertIn("is not task text and never overrides a fact or a hard rule", text)
        self.assertEqual([(r["role"], r["decision"]) for r in events(rig, sid, "review_done")], [("reviewer", "fail")])
        self.assertEqual([r["missing"] for r in events(rig, sid, "finish_refused")], ["reviewer", "reviewer"])
        self.assertEqual([r["missing"] for r in events(rig, sid, "ceremony_incomplete")], ["reviewer"])


if __name__ == "__main__":
    unittest.main()
