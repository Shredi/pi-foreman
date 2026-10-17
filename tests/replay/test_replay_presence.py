"""Replay: sidebar presence states (R11 P4) in the presence file's `presence` field, one case per state.

working (a foreman turn runs), waiting-owner (an open permission ask), waiting-external (only a
foreman_wait timer is pending) and idle (a settled session with nothing open). The legacy `state`
field is checked alongside. Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import json
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestPresenceStates(ReplayCase):
    def setUp(self):
        super().setUp()
        self.rig_ = self.rig("presence", load_fixture("presence_states"), config={"wait": {"batchWindowSeconds": 0}}, permissions="baseline")

    def _file(self, pi):
        return self.rig_.agent / "pi-foreman" / "state" / "live" / ("%s.json" % pi.session_id())

    @staticmethod
    def _read(path):
        try:
            return json.loads(path.read_text("utf-8"))
        except (OSError, ValueError):
            return {}

    def _until(self, path, presence, seconds=15):
        deadline = time.time() + seconds
        seen = None
        while time.time() < deadline:
            seen = self._read(path)
            if seen.get("presence") == presence:
                return seen
            time.sleep(0.1)
        self.fail("presence never became %s; last %s" % (presence, seen))

    def test_replay_presence_idle(self):
        pi = self.rig_.start()
        path = self._file(pi)
        pi.prompt("[[replay:p_idle]] nothing", timeout=60)
        seen = self._until(path, "idle")
        pi.close()
        self.assertEqual(seen["state"], "idle")

    def test_replay_presence_working(self):
        pi = self.rig_.start()
        path = self._file(pi)
        seen = []
        stop = threading.Event()

        def sample():
            while not stop.is_set():
                d = self._read(path)
                seen.append((d.get("presence"), d.get("state")))
                time.sleep(0.1)

        t = threading.Thread(target=sample, daemon=True)
        t.start()
        recs = pi.prompt("[[replay:p_work]] launch", timeout=60)
        pi.wait_child_notify(timeout=120)
        stop.set()
        t.join(5)
        pi.close()
        [(_, err, _)] = tool_results(recs, "subagent")
        self.assertFalse(err)
        # A live child alone is work: presence says working while the legacy state is already idle.
        self.assertIn(("working", "idle"), seen)

    def test_replay_presence_waiting_owner(self):
        pi = self.rig_.start()
        path = self._file(pi)
        seen = []

        def look(_rec):
            seen.append(self._until(path, "waiting-owner"))
            return {"confirmed": True}

        recs = pi.prompt("[[replay:p_ask]] ask", answers=[look], timeout=60)
        pi.close()
        self.assertEqual(len(tool_results(recs, "bash")), 1)
        self.assertEqual(seen[0]["state"], "blocked")  # legacy name kept for older readers

    def test_replay_presence_waiting_external(self):
        pi = self.rig_.start()
        path = self._file(pi)
        pi.prompt("[[replay:p_wait]] wait", timeout=60)
        seen = self._until(path, "waiting-external")
        pi.close()
        self.assertEqual(seen["state"], "working")  # legacy: a pending wait reads as work
        self.assertEqual([w["kind"] for w in seen["waits"]], ["timer"])


if __name__ == "__main__":
    unittest.main()
