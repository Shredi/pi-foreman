"""Replay: sidebar presence states (R11 P4) in the presence file's `presence` field, one case per state.

working (a foreman turn runs), needs-you (an open permission ask), waiting-external (only a
foreman_wait timer is pending) and idle (a settled session with nothing open). The legacy `state`
field is checked alongside. Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import json
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import PROVIDER_A, load_fixture, tool_results, wait_until
from test_replay import REASON, ReplayCase


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestPresenceStates(ReplayCase):
    def setUp(self):
        super().setUp()
        self.rig_ = self.rig("presence", load_fixture("presence_states"), config={"wait": {"batchWindowSeconds": 0}, "providers": {PROVIDER_A: {"review": {"model": "%s/review-owner" % PROVIDER_A}}}})

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
        # The child holds in a bash loop until the marker exists, so it is live for as long as the test wants, whatever the scheduling.
        self.user_permissions(self.rig_, {"allow": ["Bash(until test -f presence-release.marker*)"]})
        pi = self.rig_.start()
        path = self._file(pi)
        recs = pi.prompt("[[replay:p_work]] launch", timeout=60)
        [(_, err, _)] = tool_results(recs, "subagent")
        self.assertFalse(err)
        pair = lambda: (lambda d: (d.get("presence"), d.get("state")))(self._read(path))  # noqa: E731
        # A live child alone is work: presence says working while the legacy state is already idle (the file lags a turn end by up to 1 s).
        wait_until(lambda: pair() == ("working", "idle"), timeout=30, describe=lambda _: "last pair %s" % (pair(),), interval=0.1)
        (self.rig_.project / "presence-release.marker").write_text("go", "utf-8")
        pi.wait_child_notify(timeout=120)
        wait_until(lambda: pair() == ("idle", "idle"), timeout=30, describe=lambda _: "last pair %s" % (pair(),), interval=0.1)
        pi.close()

    def test_replay_presence_needs_you(self):  # an own permission ask is needs-you since round 73 (was waiting-owner)
        # the ask is the owner dialog of a judge-first line (`git branch -D old-topic`) the fake judge answers `owner` with a class for (an unsure judge refuses and opens no dialog)
        pi = self.rig_.start()
        path = self._file(pi)
        seen = []

        def look(_rec):
            seen.append(self._until(path, "needs-you"))
            return {"value": "allow once"}

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
