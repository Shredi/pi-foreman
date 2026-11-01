"""Child bash under the rules-first gate (frugal-roles D4).

A print-only `cd sub; sed -n ..; sed -n ..` chain is a built-in read default (`default-read`) with no review call; a write
command outside the worktree (`touch ../made.txt`) is refused by the child deny set (`child-write-outside`) and the child gets
that deny text; `sed -n '1wwritten' sub/f.go` writes inside the worktree, which is routine for a child (`mode:no-rule`), so it runs and
creates `written` in the project. No dialog opens and no classifier call is made.
Same prerequisites and skips as test_replay.py."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestChildSed(ReplayCase):
    def test_sed_chain_allowed_and_headless_defer_denied_with_forms(self):
        rig = self.rig("child-sed", load_fixture("child_sed"), permissions="baseline")
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
        self.assertEqual(reviews, [], reviews)  # r79: no line of this child reaches the classifier
        gate = [r for r in events if r.get("event") == "guard" and r.get("guard") == "gate" and r.get("toolFamily") == "bash"]
        self.assertEqual([(r.get("role"), r.get("decision"), r.get("rule")) for r in gate], [
            ("builder", "allowed", "default-read"),  # the sed chain
            ("builder", "blocked", "child-write-outside"),  # touch ../made.txt
            ("builder", "allowed", "mode:no-rule"),  # sed -n '1wwritten' sub/f.go: a write inside the worktree
        ], gate)
        self.assertFalse((rig.project.parent / "made.txt").exists())
        self.assertTrue((rig.project / "written").is_file(), "the in-worktree sed write ran")
        self.assertFalse((sub / "written").exists())
        text = "\n".join(p.read_text("utf-8", "replace") for p in rig.agent.rglob("*.jsonl"))
        self.assertIn("denied for child sessions (child-write-outside)", text)
        self.assertIn("package g", text)  # the sed chain ran
        self.assertIn("sed -n", text)


if __name__ == "__main__":
    unittest.main()
