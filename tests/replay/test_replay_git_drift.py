"""Replay: git config drift between a child launch and the foreman's next git command (T1).

The child writes nothing. The test itself appends a key to the project's .git/config after the
launch (standing in for a child that planted it); the foreman's next `git status` then asks,
naming the key but not its value. Denied -> blocked; approved -> runs and becomes the new
baseline, so the following `git status` runs without an ask. Same prerequisites and skips as
test_replay.py.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, shape, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


def confirms(recs):
    return [r for r in recs if r.get("type") == "extension_ui_request" and r.get("method") == "confirm"]


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestGitDrift(ReplayCase):
    def test_planted_config_after_launch_asks_before_foreman_git(self):
        rig = self.rig("gitdrift", load_fixture("git_drift"))
        pi = rig.start()
        sid = pi.session_id()
        res = tool_results(pi.prompt("[[replay:g1]] launch", timeout=60), "subagent")
        self.assertEqual([e for _, e, _ in res], [False], res)
        pi.wait_child_notify(timeout=120)

        with open(rig.project / ".git" / "config", "a", encoding="utf-8") as f:
            f.write("[replaydrift]\n\tmarker = planted-value\n")

        recs = pi.prompt("[[replay:g2]] deny", answers=[{"confirmed": False}], timeout=60)
        [ask] = confirms(recs)
        self.assertIn("replaydrift.marker", ask.get("message", ""))
        self.assertNotIn("planted-value", ask.get("message", ""))
        [(_, err, text)] = tool_results(recs, "bash")
        self.assertTrue(err)
        self.assertTrue(text.startswith("Denied by the user."), text)

        recs = pi.prompt("[[replay:g2]] approve", answers=[{"confirmed": True}], timeout=60)
        self.assertEqual(len(confirms(recs)), 1)
        [(_, err, _)] = tool_results(recs, "bash")
        self.assertFalse(err)

        recs = pi.prompt("[[replay:g2]] again", timeout=60)
        self.assertEqual(confirms(recs), [])
        [(_, err, _)] = tool_results(recs, "bash")
        self.assertFalse(err)
        pi.close()

        trace = rig.traces()["trace-" + sid]
        drift = [r for r in trace if r.get("event") == "git_config_drift"]
        self.assertEqual(shape(drift, ("event", "decision")), [
            {"event": "git_config_drift", "decision": "denied"},
            {"event": "git_config_drift", "decision": "approved"},
        ])


if __name__ == "__main__":
    unittest.main()
