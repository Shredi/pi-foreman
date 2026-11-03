"""scripts/foreman_radar.py: a remote entry's glyph follows `remoteLive` (hc terminal state) with an open ask first."""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import foreman_radar as fr  # noqa: E402

NOW = 1_800_000_000.0
LONG_AGO = NOW - 3 * 3600


def entry(status="open", live=None, **extra):
    e = {"status": status, "machine": "alpha"}
    if live is not None:
        e["remoteLive"] = {"state": live, "seenAt": "2026-11-03T12:00:00.000Z", "address": "alpha/t1"}
    e.update(extra)
    return e


class RemoteGlyphTest(unittest.TestCase):
    def test_hc_state_decides_with_no_freshness_window(self):
        for word, want in (("blocked", ("blocked", "blocked")), ("working", ("working", "working")), ("idle", ("idle", "idle")),
                           ("done", ("idle", "idle")), ("lost", ("idle", "finished"))):
            self.assertEqual(fr.remote_glyph(entry(live=word), LONG_AGO, NOW), want, word)

    def test_open_ask_comes_first(self):
        e = entry(live="working", ask={"seq": 2})
        self.assertEqual(fr.remote_glyph(e, LONG_AGO, NOW), ("blocked", "ask"))
        self.assertEqual(fr.remote_glyph(entry("closing", live="working", ask={"seq": 2}), LONG_AGO, NOW), ("working", "working"))

    def test_without_remote_live_the_registry_status_decides(self):
        self.assertEqual(fr.remote_glyph(entry(), LONG_AGO, NOW), fr.reg_glyph("open", LONG_AGO, NOW))
        self.assertEqual(fr.remote_glyph(entry("pending"), NOW - 10, NOW), ("starting", "pending"))

    def test_closed_and_unknown_words_are_not_live(self):
        self.assertEqual(fr.remote_glyph(entry("closed", live="working"), LONG_AGO, NOW), ("idle", "closed"))
        self.assertEqual(fr.remote_glyph(entry(live="weird"), LONG_AGO, NOW), fr.reg_glyph("open", LONG_AGO, NOW))

    def test_a_remote_ask_node_carries_the_ask_row(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        adir = Path(tmp) / "agent"
        reg = adir / "pi-foreman" / "state" / "sessions.json"
        reg.parent.mkdir(parents=True)
        opened = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(NOW - 600))
        reg.write_text(json.dumps({"version": 1, "sessions": [
            {"label": "demo", "child": "c1", "handoff": str(adir / "m" / "x"), "opened": opened, "parent": "", "status": "open",
             "machine": "alpha", "remoteLive": {"state": "working"}, "ask": {"seq": 3, "path": "/m/x/ask.md"}}]}), "utf-8")
        (node,) = fr.snapshot(adir, NOW, 24.0)
        self.assertEqual((node["name"], node["state"], node["glyph"]), ("demo@alpha", "ask", "blocked"))
        self.assertEqual(node["asks"], [{"n": 3, "topic": "remote"}])


if __name__ == "__main__":
    unittest.main()
