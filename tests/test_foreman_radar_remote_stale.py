"""scripts/foreman_radar.py: a remote node carries `remoteStale` once the parent has not heard from its terminal for 3 minutes;
the Herdr sidebar's remote row then says `stale <m>m`."""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "integrations" / "herdr" / "pi-foreman-sidebar"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import _isolation  # noqa: E402,F401
import foreman_radar as fr  # noqa: E402
import sidebar  # noqa: E402

NOW = 1_800_000_000.0


def iso(at):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(at))


class RemoteStaleTest(unittest.TestCase):
    def doc(self, contact_age=None, ask=None, status="open"):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        adir = Path(tmp) / "agent"
        state = adir / "pi-foreman" / "state"
        state.mkdir(parents=True)
        e = {"label": "demo", "child": "c1", "handoff": str(adir / "m" / "x"), "opened": iso(NOW - 900), "parent": "", "status": status,
             "machine": "alpha", "remoteLive": {"state": "working"}}
        if ask:
            e["ask"] = {"seq": 3, "n": 3, "path": "/m/x/ask.md"}
        (state / "sessions.json").write_text(json.dumps({"version": 1, "sessions": [e]}), "utf-8")
        if contact_age is not None:
            (state / "remote-contact").mkdir()
            (state / "remote-contact" / "c1.json").write_text(
                json.dumps({"child": "c1", "contactAt": iso(NOW - contact_age)}), "utf-8")
        d = fr.json_doc(fr.snapshot(adir, NOW, 24.0), NOW, "unicode", fr.load_symbols("unicode"))
        (node,) = d["roots"]
        return node

    def test_contact_four_minutes_old_marks_the_node_and_keeps_its_words(self):
        n = self.doc(240)
        self.assertEqual(n["remoteStale"], 240)
        self.assertEqual((n["state"], n["sym"]), ("working", "working"))

    def test_contact_one_minute_old_or_no_file_adds_nothing(self):
        self.assertNotIn("remoteStale", self.doc(60))
        self.assertNotIn("remoteStale", self.doc(None))

    def test_an_open_ask_wins_and_a_closed_entry_is_not_marked(self):
        n = self.doc(600, ask=True)
        self.assertEqual(n["state"], "ask")
        self.assertNotIn("remoteStale", n)
        self.assertNotIn("remoteStale", self.doc(600, status="closed"))

    def test_sidebar_remote_label_appends_the_stale_marker(self):
        base = {"name": "demo@alpha", "state": "working", "age_s": 30}
        self.assertEqual(sidebar._remote_label({**base, "remoteStale": 240}), sidebar._remote_label(base) + " · stale 4m")
        self.assertNotIn("stale", sidebar._remote_label(base))


if __name__ == "__main__":
    unittest.main()
