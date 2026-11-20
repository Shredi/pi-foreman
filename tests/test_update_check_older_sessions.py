"""The Python twin of extensions/core-adapter/harnessid.mjs: the same fixture and the same lines as test/d105-older-sessions.test.ts."""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_update_check as uc  # noqa: E402

NOW = datetime(2026, 11, 20, 9, 0, 0, tzinfo=timezone.utc).timestamp()
CURRENT = {"version": "2.0.0", "commit": "abc1234"}
FIXTURE = {
    "child": {"sessionId": "child", "label": "job", "cwd": "/w/job", "pid": 101, "parentIntercom": "fm-parent", "harness": {"version": "1.0.0", "commit": "old1234"}},
    "plain": {"sessionId": "plain", "cwd": "/w/main", "pid": 102},
    "current": {"sessionId": "current", "label": "same", "pid": 103, "parentIntercom": "fm-parent", "harness": CURRENT},
    "dead": {"sessionId": "dead", "label": "gone", "pid": 104, "parentIntercom": "fm-parent"},
    "stale": {"sessionId": "stale", "label": "late", "pid": 105, "parentIntercom": "fm-parent", "heartbeat": -200},
    "done": {"sessionId": "done", "label": "fin", "pid": 106, "parentIntercom": "fm-parent", "state": "done"},
}


class OlderSessions(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        live = Path(self.d) / "pi-foreman" / "state" / "live"
        live.mkdir(parents=True)
        for name, f in FIXTURE.items():
            f = dict(f)
            beat = NOW + f.pop("heartbeat", 0)
            rec = {"heartbeatAt": datetime.fromtimestamp(beat, timezone.utc).isoformat().replace("+00:00", "Z"), "state": "idle", **f}
            (live / (name + ".json")).write_text(json.dumps(rec), encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_same_sessions_and_lines_as_the_node_side(self):
        out = uc.older_sessions(self.d, CURRENT, now=NOW, alive=lambda pid: pid != 104, me=999)
        self.assertEqual([s["sessionId"] for s in out], ["child", "plain"])
        self.assertEqual(out[0]["restart"], "foreman session restart job")
        self.assertEqual(out[1]["restart"], "quit it (/quit), then in /w/main: pi --session plain")
        self.assertEqual(uc.older_lines(out), [
            "2 running sessions still run older pi-foreman code (an update does not reach a running session); restart each:",
            "  job: foreman session restart job",
            "  plain: quit it (/quit), then in /w/main: pi --session plain",
        ])
        self.assertEqual(uc.older_lines([]), [])

    def test_this_process_is_skipped(self):
        out = uc.older_sessions(self.d, CURRENT, now=NOW, alive=lambda pid: True, me=101)
        self.assertNotIn("child", [s["sessionId"] for s in out])


if __name__ == "__main__":
    unittest.main()
