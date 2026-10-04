"""Replay: a detached child cannot `git push` (design D4, ledger item 11).

The project is the rig's fresh `git init` repo with no remote, so even a leaked push would
only fail. The child first runs `echo ok > control.txt` (proves its bash calls run), then
`git push origin main || echo leaked > leaked.txt`: if the git guard let the call through,
the push would fail and leaked.txt would appear. The guard blocks the whole call first.

Run: python -m unittest discover -s tests/replay -v (same prerequisites as test_replay.py).
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, notifications, tool_results, trace_of  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestChildGitGuard(ReplayCase):
    def test_child_push_blocked_before_execution(self):
        rig = self.rig("gitguard", load_fixture("git_guard"))
        pi = rig.start()
        res = tool_results(pi.prompt("[[replay:h1]] start", timeout=60))
        self.assertEqual([(n, e) for n, e, _ in res], [("subagent", False)])
        notice, _ = pi.wait_child_notify(timeout=120)
        self.assertIn("child: push attempt finished", notice)
        doctor = "\n".join(notifications(pi.prompt("/foreman doctor", timeout=30)))
        pi.close()
        self.assertIn("required child extension pi-foreman-git-guard:", doctor)

        def found(name):
            return [p for p in rig.root.rglob(name) if p.is_file()]

        self.assertTrue(found("control.txt"), "the child's harmless bash call did not run")
        self.assertEqual(found("leaked.txt"), [], "the git push call reached the shell")
        # The adapter ran in the child too (destructive guard on both calls) and did not add
        # the foreman's main-mode lint there.
        child = trace_of(rig.traces(), "child")
        self.assertIsNotNone(child, "adapter did not load in the child")
        guards = [r.get("guard") for r in child if r.get("event") == "guard"]
        self.assertNotIn("git_guard", guards)
        self.assertIn("destructive_guard", guards)


if __name__ == "__main__":
    unittest.main()
