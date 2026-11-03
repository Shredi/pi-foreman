"""scripts/foreman_radar.py --json: dots of a stale (lost) or finished session's live file are not trusted."""
from __future__ import annotations

import contextlib
import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "scripts"))

from test_foreman_radar import NOW, Fixture, live  # noqa: E402
import foreman_radar as fr  # noqa: E402

DOT = {"n": 73, "state": "fail", "label": "#73", "src": "pr"}


class StaleDotTests(Fixture):
    def root(self, **kw):
        d = live("s-d", "d", "fm-d", **kw)
        d["dots"] = [dict(DOT)]
        self.put_live(d)
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(fr.time, "time", return_value=NOW):
            self.assertEqual(fr.main(["--agent-dir", str(self.adir), "--json"]), 0)
        (root,) = json.loads(out.getvalue())["roots"]
        return root

    def test_a_fresh_live_file_keeps_its_dots(self):
        self.assertEqual(self.root(hb=5)["dots"], [DOT])

    def test_a_heartbeat_older_than_the_lost_bound_drops_the_dots(self):
        self.assertNotIn("dots", self.root(hb=int(fr.LOST_AFTER) + 30))

    def test_a_finished_session_drops_its_dots(self):
        self.assertNotIn("dots", self.root(state="done", hb=5))


if __name__ == "__main__":
    unittest.main()
