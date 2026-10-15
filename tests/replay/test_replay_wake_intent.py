"""Replay: a wake run keeps the review intent (ledger item 7, Pi 1.2 before_agent_start).

Pi 1.2 fires before_agent_start for an idle `pi.sendMessage(..., {triggerTurn: true})` run (a
`foreman_wait` wake) with messageType "custom" and no prompt. The adapter must not reset the
review intent (the user's request the permission reviewer sees) to "" on that run, and the next
user turn's intent must stand. The trace `turn` event carries `chars`, the intent length at the
end of each run. Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_replay import REASON, ReplayCase  # noqa: E402

FIRST = "[[replay:k1]] keep this request as the review intent"
SECOND = "[[replay:k3]] the second request"


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestWakeKeepsIntent(ReplayCase):
    def test_wake_then_user_keeps_intent(self):
        script = {"foreman": {
            "k1": [{"tools": [{"name": "foreman_wait", "arguments": {"action": "start", "kind": "timer", "seconds": 1, "note": "[[replay:k2]] t"}}]},
                   {"text": "Waiting."}],
            "k2": [{"text": "Woken, intent intact."}],
            "k3": [{"text": "Second done."}]}}
        rig = self.rig("wakeintent", script, config={"wait": {"batchWindowSeconds": 0}}, permissions="baseline")
        pi = rig.start()
        sid = pi.session_id()
        recs = list(pi.prompt(FIRST, timeout=60))
        deadline = time.time() + 30
        while not any(r.get("type") == "message_end" and "intent intact" in str((r.get("message") or {}).get("content")) for r in recs):
            recs.append(pi._next(deadline))
        while recs[-1].get("type") != "agent_settled":
            recs.append(pi._next(deadline))
        pi.prompt(SECOND, timeout=60)
        pi.close()

        safe = "".join(c for c in sid if c.isalnum() or c in "-_")
        trace = rig.traces()["trace-" + safe]
        turns = [(r["cause"], r.get("chars")) for r in trace if r.get("event") == "turn"]
        self.assertEqual(turns, [("user", len(FIRST)), ("wake", len(FIRST)), ("user", len(SECOND))], turns)


if __name__ == "__main__":
    unittest.main()
