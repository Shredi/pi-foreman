"""Child bash under the rules-first gate (ladder-polish items 1 and 7).

`git checkout -- pkg/hub_test.go` on a modified tracked test file is the dangerous class `danger-git` (it discards changes): the
whitelist is empty, so the classifier makes no call and the child's ask goes to the parent's dialog, which the rig dismisses; the child
is denied and the file stays broken. A `sed -n ..; grep .. | head` chain is a read default (`default-read`) with no record of its own.
Same prerequisites and skips as test_replay.py."""
from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestChildEffects(ReplayCase):
    def test_test_restore_and_chain_allowed_without_model(self):
        rig = self.rig("child-effects", load_fixture("child_effects"), permissions="baseline")
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
        # the one dialog is the child's ask for the restore, shown in the parent's pane
        self.assertEqual(len(dialogs), 1, dialogs)
        self.assertIn("cause: danger-git", dialogs[0]["title"])
        self.assertIn("git checkout -- pkg/hub_test.go", dialogs[0]["title"])
        events = [r for recs_ in rig.traces().values() for r in recs_]
        reviews = [r for r in events if r.get("event") == "review"]
        # ledger item 26: the owner's subagent launch is allowed by the gate default `default-role-launch` (a guard record, no review call), so it no longer shows as a review 'allow'
        launch = [r for r in events if r.get("event") == "guard" and r.get("guard") == "gate" and r.get("toolFamily") == "subagent"]
        self.assertTrue(any(r.get("decision") == "allowed" and r.get("rule") == "default-role-launch" for r in launch), launch)
        self.assertEqual([r.get("decision") for r in reviews], ["escalate"], reviews)  # r79: the classifier escalates the restore at once (empty whitelist, no model call)
        self.assertEqual([r.get("role") for r in reviews], ["builder"], reviews)
        gate = [r for r in events if r.get("event") == "guard" and r.get("guard") == "gate" and r.get("toolFamily") == "bash"]
        self.assertEqual([(r.get("decision"), r.get("rule")) for r in gate], [("blocked", "danger-git"), ("allowed", "default-read")], gate)
        # the dismissed ask denies the restore for the child, so the file stays broken
        self.assertEqual((pkg / "hub_test.go").read_text("utf-8"), "package broken\n")


if __name__ == "__main__":
    unittest.main()
