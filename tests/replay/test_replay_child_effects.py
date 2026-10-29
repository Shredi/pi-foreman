"""Child bash asks the review link allows by effect, headless, with a deferring review model
(ladder-polish items 1 and 7).

`git checkout -- pkg/hub_test.go` on a modified tracked test file passes the git guard
(test_restore) and is then allowed by the link without a model call (label `test-restore`), so no
`review_defer_headless` follows and the file is restored. A `sed -n ..; grep .. | head` chain is
allowed segment by segment (label `sed-read`, trace `chain_allow {segments: 3}`).
Same prerequisites and skips as test_replay.py."""
from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import PROVIDER_A, load_fixture  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestChildEffects(ReplayCase):
    def test_test_restore_and_chain_allowed_without_model(self):
        rig = self.rig("child-effects", load_fixture("child_effects"), permissions="baseline",
                       config={"providers": {PROVIDER_A: {"review": {"model": "%s/review-child-unreachable" % PROVIDER_A}}},
                               "review": {"headless": True}})
        pkg = rig.project / "pkg"
        pkg.mkdir()
        (pkg / "hub.go").write_text("package pkg\n", "utf-8")
        (pkg / "hub_test.go").write_text("package pkg\n", "utf-8")
        git = ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"]
        subprocess.run(git + ["add", "pkg"], cwd=str(rig.project), check=True, timeout=60)
        subprocess.run(git + ["commit", "-q", "-m", "init"], cwd=str(rig.project), check=True, timeout=60)
        (pkg / "hub_test.go").write_text("package broken\n", "utf-8")
        pi = rig.start()
        pi.prompt("[[replay:b1]] go", timeout=60)
        notice, recs = pi.wait_child_notify(timeout=120)
        pi.close()
        self.assertIn("effects child finished", notice)
        dialogs = [r for r in recs if r.get("type") == "extension_ui_request" and r.get("method") in ("select", "confirm")]
        self.assertEqual(dialogs, [], dialogs)
        events = [r for recs_ in rig.traces().values() for r in recs_]
        reviews = [r for r in events if r.get("event") == "review"]
        # ledger item 26: the owner's subagent launch is allowed by the gate default `default-role-launch` (a guard record, no review call), so it no longer shows as a review 'allow'
        launch = [r for r in events if r.get("event") == "guard" and r.get("guard") == "gate" and r.get("toolFamily") == "subagent"]
        self.assertTrue(any(r.get("decision") == "allowed" and r.get("rule") == "default-role-launch" for r in launch), launch)
        self.assertEqual([r.get("decision") for r in reviews], ["unreachable"], reviews)  # R41: the sed read and test-restore is a gate default (no record); one write reaches the gate review, unreachable, and a child is denied
        self.assertTrue(all(r.get("model") is None for r in reviews), reviews)
        self.assertEqual([r.get("class") for r in reviews], [None], reviews)
        self.assertEqual([r for r in events if r.get("event") == "review_defer_headless"], [])
        self.assertEqual([r.get("segments") for r in events if r.get("event") == "chain_allow"], [])  # R41: the review link's chain_allow record is gone (old [3]); the gate defaults allow the chain with no record
        # R41 gap (slice 5): the test-file restore is no gate default; the unreachable review denies it for the child, so the file stays broken
        self.assertEqual((pkg / "hub_test.go").read_text("utf-8"), "package broken\n")


if __name__ == "__main__":
    unittest.main()
