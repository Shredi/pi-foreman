"""Child bash asks under the baseline plus a deferring review model (frugal-roles D4).

The baseline has no sed rule, so every sed unit asks and is forwarded to the foreman. A print-only
`cd sub; sed -n ..; sed -n ..` chain is allowed there without a model call (label `sed-read`); a write
command outside the worktree (`touch ../made.txt`) and `sed -n '1wwritten'` are forwarded, the review model defers, and with no human
(`review.headless`) the child gets a deny that names the allowed forms and the foreman traces
`review_defer_headless`; the sed write never runs.
Same prerequisites and skips as test_replay.py."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import PROVIDER_A, load_fixture  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestChildSed(ReplayCase):
    def test_sed_chain_allowed_and_headless_defer_denied_with_forms(self):
        rig = self.rig("child-sed", load_fixture("child_sed"), permissions="baseline",
                       config={"providers": {PROVIDER_A: {"review": {"model": "%s/review-child-unreachable" % PROVIDER_A}}},
                               "review": {"headless": True}})
        sub = rig.project / "sub"
        sub.mkdir()
        (sub / "f.go").write_text("package f\n" * 30, "utf-8")
        (sub / "g.go").write_text("package g\n" * 30, "utf-8")
        pi = rig.start()
        pi.prompt("[[replay:b1]] go", timeout=60)
        notice, recs = pi.wait_child_notify(timeout=120)
        pi.close()
        self.assertIn("sed child finished", notice)
        dialogs = [r for r in recs if r.get("type") == "extension_ui_request" and r.get("method") in ("select", "confirm")]
        self.assertEqual(dialogs, [], dialogs)
        events = [r for recs_ in rig.traces().values() for r in recs_]
        reviews = [r for r in events if r.get("event") == "review"]
        # ledger item 26: the owner's subagent launch is allowed by the gate default `default-role-launch` (a guard record, no review call), so it no longer shows as a review 'allow'
        launch = [r for r in events if r.get("event") == "guard" and r.get("guard") == "gate" and r.get("toolFamily") == "subagent"]
        self.assertTrue(any(r.get("decision") == "allowed" and r.get("rule") == "default-role-launch" for r in launch), launch)
        self.assertEqual([r.get("decision") for r in reviews], ["unreachable", "unreachable"], reviews)  # R41: the sed chain is a gate default (no record), both writes reach the unreachable review and a child is denied
        self.assertIsNone(reviews[0].get("model"), reviews[0])
        self.assertEqual([r for r in events if r.get("event") == "review_defer_headless"], [])  # the old headless defer record is gone
        self.assertEqual([r.get("role") for r in reviews], ["builder", "builder"], reviews)
        self.assertFalse((rig.project.parent / "made.txt").exists())
        self.assertFalse((rig.project / "written").exists())
        self.assertFalse((sub / "written").exists())
        text = "\n".join(p.read_text("utf-8", "replace") for p in rig.agent.rglob("*.jsonl"))
        self.assertIn("the permission review is unreachable", text)
        self.assertIn("package g", text)  # the sed chain ran
        self.assertIn("sed -n", text)


if __name__ == "__main__":
    unittest.main()
