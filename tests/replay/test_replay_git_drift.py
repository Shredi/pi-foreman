"""Replay: git config drift between a child launch and the foreman's next git command (T1).

The child writes nothing. The test itself appends a key to the project's .git/config after the
launch (standing in for a child that planted it); the foreman's next `git status` then asks,
naming the key but not its value. Denied -> blocked; approved -> runs and becomes the new
baseline, so the following `git status` runs without an ask. Same prerequisites and skips as
test_replay.py.
"""
from __future__ import annotations

import json
import sys
import time
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

    def test_child_launch_drift_ask_shows_blocked(self):
        """The child-launch gate's ask raises one Herdr block and the presence file reads blocked while open."""
        rig = self.rig("gitdrift-launch", load_fixture("git_drift"))
        herdr = rig.root / "herdr.jsonl"
        pi = rig.start(env={"FOREMAN_FAKE_HERDR": str(herdr), "HERDR_ENV": "1"})
        sid = pi.session_id()
        pi.prompt("[[replay:g1]] launch", timeout=60)
        pi.wait_child_notify(timeout=120)
        with open(rig.project / ".git" / "config", "a", encoding="utf-8") as f:
            f.write("[replaydrift]\n\tmarker = planted-value\n")
        presence = rig.agent / "pi-foreman" / "state" / "live" / ("%s.json" % sid)
        seen = []

        def look(_rec):
            deadline = time.time() + 5
            while time.time() < deadline:
                try:
                    seen.append(json.loads(presence.read_text("utf-8")).get("state"))
                except (OSError, ValueError):
                    pass
                if seen and seen[-1] == "blocked":
                    break
                time.sleep(0.1)
            return {"confirmed": False}

        recs = pi.prompt("[[replay:g3]] relaunch", answers=[look], timeout=60)
        pi.close()
        [ask] = confirms(recs)
        self.assertIn("replaydrift.marker", ask.get("message", ""))
        [(_, err, _)] = tool_results(recs, "subagent")
        self.assertTrue(err)
        self.assertEqual(seen[-1:], ["blocked"], seen)
        blocked = [json.loads(line) for line in herdr.read_text("utf-8").splitlines()]
        self.assertEqual(blocked, [{"active": True, "label": "pi-foreman: git config changed"}, {"active": False}])


if __name__ == "__main__":
    unittest.main()
