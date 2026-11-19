"""Replay: a child's shell env keeps the push credentials and gets the prompt switches.

The foreman runs with dummy SSH_AUTH_SOCK and GH_TOKEN values. Its own bash call and a
builder child's bash call each write the NAMES (never values) of the relevant variables to a
file. Both keep the credentials (a builder pushes its own branch); the child gets the git prompt
switches and no injected GIT_CONFIG_COUNT. Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results
from test_replay import REASON, ReplayCase

DUMMY = {"SSH_AUTH_SOCK": "/nonexistent/replay-agent.sock", "GH_TOKEN": "replay-dummy",
         "GIT_TERMINAL_PROMPT": "1", "GCM_INTERACTIVE": "always"}


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestChildEnv(ReplayCase):
    def test_child_env_keeps_push_credentials(self):
        rig = self.rig("childenv", load_fixture("child_env"))
        pi = rig.start(env=DUMMY)
        res = tool_results(pi.prompt("[[replay:e1]] start", timeout=60))
        self.assertEqual([(n, e) for n, e, _ in res], [("bash", False), ("subagent", False)])
        notice, _ = pi.wait_child_notify(timeout=120)
        self.assertIn("child: env listed", notice)
        pi.close()

        def names(file):
            [path] = [p for p in rig.root.rglob(file) if p.is_file()]
            return path.read_text("utf-8").split()

        # The foreman's GIT_CONFIG_COUNT carries core.fsmonitor=false / protocol.ext.allow=never (T1).
        self.assertEqual(names("main-env.txt"), ["GCM_INTERACTIVE", "GH_TOKEN", "GIT_CONFIG_COUNT", "GIT_TERMINAL_PROMPT", "SSH_AUTH_SOCK"])
        self.assertEqual(names("child-env.txt"), ["GCM_INTERACTIVE", "GH_TOKEN", "GIT_TERMINAL_PROMPT", "SSH_AUTH_SOCK"])


if __name__ == "__main__":
    unittest.main()
