"""scripts/foreman_radar.py: an open remote row whose last notice is a result and whose terminal is idle reads "result delivered, idle"."""
import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "foreman_radar.py"
spec = importlib.util.spec_from_file_location("foreman_radar_result", SCRIPT)
fr = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = fr
spec.loader.exec_module(fr)

NOW, LONG_AGO = 1_800_000_000.0, 1_700_000_000.0


def entry(status="open", live="idle", kind="result"):
    e = {"status": status, "machine": "alpha", "remoteLive": {"state": live}}
    if kind:
        e["last"] = {"kind": kind, "at": "2026-11-03T12:00:00.000Z"}
    return e


class ResultIdleTest(unittest.TestCase):
    def test_open_result_idle_and_done(self):
        for live in ("idle", "done"):
            self.assertEqual(fr.remote_glyph(entry(live=live), LONG_AGO, NOW), ("idle", "result delivered, idle"))

    def test_other_cases_are_unchanged(self):
        self.assertEqual(fr.remote_glyph(entry(live="working"), LONG_AGO, NOW), ("working", "working"))
        self.assertEqual(fr.remote_glyph(entry(kind="update"), LONG_AGO, NOW), ("idle", "idle"))
        self.assertEqual(fr.remote_glyph(entry(kind=None), LONG_AGO, NOW), ("idle", "idle"))
        self.assertEqual(fr.remote_glyph(entry(status="closing"), LONG_AGO, NOW), ("idle", "idle"))
        self.assertEqual(fr.remote_glyph(entry(live="lost"), LONG_AGO, NOW), ("idle", "finished"))


if __name__ == "__main__":
    unittest.main()
