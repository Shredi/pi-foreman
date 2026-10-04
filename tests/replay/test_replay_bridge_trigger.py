"""Replay: a run that a child's completion notice starts is drift-checked too (security re-check R2-H1).

The fake provider is registered under the claude-bridge name (FOREMAN_FAKE_BRIDGE=1), so the
adapter treats the foreman as a claude-bridge session; the real bridge is never loaded. The test
writes the project's .claude/settings.json (standing in for a child's `npm test`), then starts a
run through `/replay-trigger`, which calls sendMessage(..., {triggerTurn: true}) exactly like
pi-subagents' completion notice: no `input` and no `before_agent_start` event fires. Denied ->
the run is aborted before the provider is called (FOREMAN_FAKE_CALLS log); approved -> the run
reaches the provider. The first session's baseline is announced. Same prerequisites as test_replay.py.
"""
from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import notifications, shape  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

BRIDGE = "claude-bridge"
SCRIPT = {"*": {"p1": [{"text": "fake: typed reply"}], "t1": [{"text": "fake: triggered reply"}]}}


def confirms(recs):
    return [r for r in recs if r.get("type") == "extension_ui_request" and r.get("method") == "confirm"]


def trigger(pi, tag, answers, timeout=60.0):
    """Send `/replay-trigger <tag>` and collect records until the run it triggers settles."""
    answers = list(answers)
    pi.send({"id": pi.next_id(), "type": "prompt", "message": "/replay-trigger %s" % tag})
    deadline = time.time() + timeout
    out = []
    while True:
        rec = pi._next(deadline)
        out.append(rec)
        pi._answer(rec, answers)
        if rec.get("type") == "agent_settled":
            return out


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestBridgeTriggeredRun(ReplayCase):
    def test_triggered_run_asks_before_the_model_request(self):
        rig = self.rig("bridgetrig", SCRIPT, providers=(BRIDGE,))
        calls = rig.root / "calls.log"
        pi = rig.start(provider=BRIDGE, env={"FOREMAN_FAKE_BRIDGE": "1", "FOREMAN_FAKE_CALLS": str(calls)})
        sid = pi.session_id()
        recs = pi.prompt("[[replay:p1]] hello", timeout=60)
        self.assertTrue(any("first session on this workspace" in n for n in notifications(pi.seen)), notifications(pi.seen))
        self.assertEqual(confirms(recs), [])
        self.assertEqual(calls.read_text("utf-8").split(), ["%s/foreman" % BRIDGE, "p1"])

        (rig.project / ".claude").mkdir()
        (rig.project / ".claude" / "settings.json").write_text('{"hooks": {"Stop": [{"command": "SECRET-CMD"}]}}', "utf-8")

        recs = trigger(pi, "t1", [{"confirmed": False}])
        [ask] = confirms(recs)
        self.assertIn(".claude/settings.json: created", ask.get("message", ""))
        self.assertNotIn("SECRET", ask.get("message", ""))
        self.assertNotIn(" t1", calls.read_text("utf-8"), "the triggered run must not reach the provider")
        self.assertTrue(any("Denied by the user" in n for n in notifications(recs)), notifications(recs))
        blocked = [r for r in pi.drain(1.0) + recs if r.get("type") == "message_end"
                   and (r.get("message") or {}).get("customType") == "pi-foreman-blocked"]
        self.assertEqual(len(blocked), 1, "the block is recorded in the session")

        recs = trigger(pi, "t1", [{"confirmed": True}])
        self.assertEqual(len(confirms(recs)), 1)
        self.assertIn("%s/foreman t1" % BRIDGE, calls.read_text("utf-8"))

        recs = trigger(pi, "t1", [])
        self.assertEqual(confirms(recs), [], "approved state is the new baseline")
        pi.close()

        drift = [r for r in rig.traces()["trace-" + sid] if r.get("event") == "claude_config_drift"]
        self.assertEqual(shape(drift, ("event", "decision")), [
            {"event": "claude_config_drift", "decision": "denied"},
            {"event": "claude_config_drift", "decision": "approved"},
        ])


if __name__ == "__main__":
    unittest.main()
