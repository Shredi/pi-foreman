"""Replay: a wake whose timer fires while the run that started it is still active (FOREMAN_FAKE_DELAY).

The wake must not merge into that run: it is delivered after the run settled and starts a run of its own,
with its own stop-gate hold. Same script as test_replay_wait.py's
test_wake_turn_keeps_the_section_and_gets_its_own_stop_hold; the delay knob forces the 1 s timer to fire
(a) before the first run's first settle and (b) inside its stop-hold continuation.
Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_replay import REASON, ReplayCase  # noqa: E402


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestWakeDuringRun(ReplayCase):
    def _race(self, name, delay, paused=False):
        ledger = "# Requirements Ledger: replay\n\n- [ ] 1. first synthetic item\n"
        script = {"foreman": {
            "s1": [{"tools": [{"name": "write", "arguments": {"path": ".workflow/LEDGER-replay.md", "content": ledger}}]},
                   {"tools": [{"name": "foreman_wait", "arguments": {"action": "start", "kind": "timer", "seconds": 1, "note": "[[replay:s2]] t"}}]},
                   {"text": "Waiting."}, {"text": "Still open."}],
            "s2": [{"tools": [{"name": "write", "arguments": {"path": ".workflow/LEDGER-second.md", "content": ledger}}]},
                   {"tools": [{"name": "foreman_wait", "arguments": {"action": "list"}}]},
                   {"text": "Woken."}, {"text": "Still open after the wake."}]}}
        rig = self.rig(name, script, config={"wait": {"batchWindowSeconds": 0}}, permissions="baseline")
        sec = rig.root / "sections.log"
        pi = rig.start(env={"FOREMAN_FAKE_SECTIONS": str(sec), "FOREMAN_FAKE_DELAY": delay})
        sid = pi.session_id()
        recs = list(pi.prompt("[[replay:s1]] go", timeout=60))
        deadline = time.time() + 30
        while not (any(r.get("type") == "message_end" and "after the wake" in str((r.get("message") or {}).get("content")) for r in recs)
                   and sum(r.get("type") == "agent_settled" for r in recs) >= 2):
            recs.append(pi._next(deadline))
        pi.close()
        calls = [line.split(" ") for line in sec.read_text("utf-8").splitlines()]
        holds = [r for r in recs if r.get("type") == "entry_appended" and (r.get("entry") or {}).get("customType") == "pi-foreman-stop-gate"]
        if paused:
            # The first settle has the timer still pending: a pause, no hold.
            self.assertEqual(len([c for c in calls if c[0] == "s1"]), 3, calls)
            self.assertEqual(len([c for c in calls if c[0] == "s2"]), 6, calls)
            self.assertEqual(len(holds), 1, "the paused run spent no hold; only the wake run is held")
        else:
            self.assertEqual(len([c for c in calls if c[0] == "s2"]), 4, calls)
            self.assertEqual(len(holds), 2, "one stop hold per run, the wake run included")
        self.assertIn("LEDGER-second.md", holds[-1]["entry"]["content"])
        self.assertEqual(sum(r.get("type") == "agent_settled" for r in recs), 2, "the wake is a run of its own")
        safe = "".join(c for c in sid if c.isalnum() or c in "-_")
        trace = rig.traces()["trace-" + safe]
        causes = [r["cause"] for r in trace if r.get("event") == "turn"]
        # The stop holds add `other` turns; the wake turn comes after the user turn and before the wake run's hold.
        self.assertEqual(causes[0], "user", causes)
        self.assertEqual(causes.count("wake"), 1, causes)
        if paused:
            # the wake run also takes both ceremony-gate refusals the paused run left unspent (hold + 2 refusals)
            self.assertEqual(causes[1:], ["wake", "other", "other", "other"], causes)
            self.assertEqual([r.get("skipped") for r in trace if r.get("event") == "finish_gate"], ["pending_wait"])
        else:
            self.assertEqual(causes[-2:], ["wake", "other"], causes)

    def test_timer_fires_before_the_first_settle(self):
        self._race("wakerace-a", "s1:2:2500")

    def test_timer_pending_at_the_first_settle_pauses_the_run(self):
        """Under the wait-pause rule a timer still pending at the first settle ends the run without a stop hold, so the old
        "timer fires inside the stop-hold continuation" race cannot occur; the wake then runs alone (no delay)."""
        self._race("wakerace-b", "", paused=True)


if __name__ == "__main__":
    unittest.main()
