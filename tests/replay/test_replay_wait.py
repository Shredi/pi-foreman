"""Replay: long wait (plan D9, ledger items 13-15, 22, 23, 39) on the fake provider.

The foreman starts a 1 s timer wait (wait.batchWindowSeconds 0) and a file wait outside the
workspace (the permission system refuses it as an external directory, before the adapter's
own bound) and one on a protected path inside it (the adapter's bound refuses it), then ends its run. The timer wakes the session without a user prompt: one
`foreman_wake` message starts a turn whose trace `turn` event has cause `wake`. The rig uses the
installer's permission baseline, so foreman_wait runs through the real permission system.
Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestLongWait(ReplayCase):
    def test_timer_wakes_the_session(self):
        rig = self.rig("wait", load_fixture("wait"), config={"wait": {"batchWindowSeconds": 0}}, permissions="baseline")
        pi = rig.start()
        sid = pi.session_id()
        recs = pi.prompt("[[replay:w1]] wait for the timer", timeout=60)
        res = tool_results(recs)
        self.assertEqual([(n, e) for n, e, _ in res], [("foreman_wait", False), ("foreman_wait", True), ("foreman_wait", True)], res)
        self.assertIn("Wait w1 (timer) started", res[0][2])
        self.assertIn("external_directory", res[1][2])
        self.assertIn("write protection", res[2][2])

        # No prompt from here on: the wake alone must start a run.
        deadline = time.time() + 30
        wake, settled = None, False
        recs = list(recs)
        while not (wake and settled):
            rec = pi._next(deadline)
            recs.append(rec)
            msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
            if rec.get("type") == "message_end" and msg.get("customType") == "foreman_wake":
                wake = msg
            if wake is not None and rec.get("type") == "agent_settled":
                settled = True
        pi.close()
        self.assertIn("w1 (timer)", str(wake.get("content")))
        self.assertIn("elapsed", str(wake.get("content")))
        self.assertTrue(any(r.get("type") == "message_end" and (r.get("message") or {}).get("role") == "assistant"
                            and "Woken by the timer" in str((r.get("message") or {}).get("content")) for r in recs))

        safe = "".join(c for c in sid if c.isalnum() or c in "-_")
        trace = rig.traces()["trace-" + safe]
        waits = [(r["decision"], r.get("toolFamily")) for r in trace if r.get("event") == "wait"]
        self.assertEqual(waits[:2], [("start", "timer"), ("refused", "file")], waits)
        self.assertIn(("resolved", "timer"), waits)
        self.assertEqual([r.get("wakeKinds") for r in trace if r.get("event") == "wait" and r["decision"] == "wake"], ["timer"])
        turns = [(r["cause"], r.get("wakeKinds")) for r in trace if r.get("event") == "turn"]
        self.assertEqual(turns, [("user", None), ("wake", "timer")])

    def test_wake_turn_keeps_the_section_and_gets_its_own_stop_hold(self):
        """Review S3 (pi-foreman section on every model call of a wake run) and S12 (stop gate)."""
        ledger = "# Requirements Ledger: replay\n\n- [ ] 1. first synthetic item\n"
        script = {"foreman": {
            "s1": [{"tools": [{"name": "write", "arguments": {"path": ".workflow/LEDGER-replay.md", "content": ledger}}]},
                   {"tools": [{"name": "foreman_wait", "arguments": {"action": "start", "kind": "timer", "seconds": 1, "note": "[[replay:s2]] t"}}]},
                   {"text": "Waiting."}, {"text": "Still open."}],
            # A second ledger: the core holds once per ledger, so only a stale stop_hook_active
            # (the previous run's continue) could keep the wake run from being held.
            "s2": [{"tools": [{"name": "write", "arguments": {"path": ".workflow/LEDGER-second.md", "content": ledger}}]},
                   {"tools": [{"name": "foreman_wait", "arguments": {"action": "list"}}]},
                   {"text": "Woken."}, {"text": "Still open after the wake."}]}}
        rig = self.rig("wakesec", script, config={"wait": {"batchWindowSeconds": 0}}, permissions="baseline")
        sec = rig.root / "sections.log"
        pi = rig.start(env={"FOREMAN_FAKE_SECTIONS": str(sec)})
        recs = list(pi.prompt("[[replay:s1]] go", timeout=60))
        deadline = time.time() + 30
        while not any(r.get("type") == "message_end" and "after the wake" in str((r.get("message") or {}).get("content")) for r in recs):
            recs.append(pi._next(deadline))
        pi.close()
        calls = [line.split(" ") for line in sec.read_text("utf-8").splitlines()]
        wake = [c for c in calls if c[0] == "s2"]
        self.assertEqual(len(wake), 4, calls)
        for tag, step, names in wake:
            self.assertIn("pi-foreman", names.split(","), (tag, step))
        holds = [r for r in recs if r.get("type") == "entry_appended" and (r.get("entry") or {}).get("customType") == "pi-foreman-stop-gate"]
        self.assertEqual(len(holds), 2, "one stop hold per run, the wake run included")
        self.assertIn("LEDGER-second.md", holds[1]["entry"]["content"])


if __name__ == "__main__":
    unittest.main()
