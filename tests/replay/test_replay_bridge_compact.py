"""Replay: a compaction on claude-bridge is drift-checked before the summary call (security re-check R3-H1).

The fake provider is registered under the claude-bridge name (FOREMAN_FAKE_BRIDGE=1); the real
bridge is never loaded. The test writes `.pi/claude-bridge.json` with an executable path that does
not exist (standing in for a child's `npm test`), then runs a manual compaction over RPC. Denied ->
Pi reports the compaction cancelled and the provider is not called for a summary; approved -> the
summary call reaches the provider. Same prerequisites as test_replay.py.
"""
from __future__ import annotations

import json
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_replay import REASON, ReplayCase  # noqa: E402

BRIDGE = "claude-bridge"
SCRIPT = {"*": {"p1": [{"text": "fake: first reply " + "x" * 400}], "p2": [{"text": "fake: second reply " + "y" * 400}]}}


def compact(pi, answers, timeout=60.0):
    """Send an RPC `compact`, answer UI requests, return (response, records)."""
    answers = list(answers)
    rid = pi.next_id()
    pi.send({"id": rid, "type": "compact"})
    deadline = time.time() + timeout
    out = []
    while True:
        rec = pi._next(deadline)
        out.append(rec)
        pi._answer(rec, answers)
        if rec.get("type") == "response" and rec.get("id") == rid:
            return rec, out


def confirms(recs):
    return [r for r in recs if r.get("type") == "extension_ui_request" and r.get("method") == "confirm"]


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestBridgeCompaction(ReplayCase):
    def test_compaction_asks_before_the_summary_call(self):
        rig = self.rig("bridgecompact", SCRIPT, providers=(BRIDGE,), settings={"compaction": {"keepRecentTokens": 1}})
        calls = rig.root / "calls.log"
        pi = rig.start(provider=BRIDGE, env={"FOREMAN_FAKE_BRIDGE": "1", "FOREMAN_FAKE_CALLS": str(calls)})
        pi.prompt("[[replay:p1]] hello", timeout=60)
        pi.prompt("[[replay:p2]] again", timeout=60)
        before = len(calls.read_text("utf-8").split("\n"))

        (rig.project / ".pi").mkdir(exist_ok=True)
        (rig.project / ".pi" / "claude-bridge.json").write_text(
            json.dumps({"provider": {"pathToClaudeCodeExecutable": str(rig.root / "no-such-claude")}}), "utf-8")

        resp, recs = compact(pi, [{"confirmed": False}])
        [ask] = confirms(recs)
        self.assertIn(".pi/claude-bridge.json: created", ask.get("message", ""))
        self.assertNotIn("no-such-claude", ask.get("message", ""), "values are never shown")
        self.assertFalse(resp.get("success"), resp)
        self.assertIn("cancelled", (resp.get("error") or "").lower())
        self.assertEqual(len(calls.read_text("utf-8").split("\n")), before, "no summary call reached the provider")

        resp, recs = compact(pi, [{"confirmed": True}])
        self.assertEqual(len(confirms(recs)), 1)
        self.assertTrue(resp.get("success"), resp)
        self.assertGreater(len(calls.read_text("utf-8").split("\n")), before, "approved: the summary call ran")
        pi.close()


if __name__ == "__main__":
    unittest.main()
