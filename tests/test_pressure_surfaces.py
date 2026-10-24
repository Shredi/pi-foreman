"""Pressure surfaces (R5 P1c): presence file -> radar JSON -> sidebar cost row, and the retro line."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "scripts"))
sys.path.insert(0, str(HERE.parent / "integrations" / "herdr" / "pi-foreman-sidebar"))

import _isolation  # noqa: E402,F401
import foreman_radar as fr  # noqa: E402
import foreman_retro as retro  # noqa: E402
import sidebar  # noqa: E402
import test_foreman_radar as tr  # noqa: E402
import test_herdr_sidebar as ts  # noqa: E402


class SidebarPressure(unittest.TestCase):
    def cost_row(self, pressure, width=40):
        snap = ts.snapshot()
        if pressure is not None:
            snap["roots"][0]["pressure"] = pressure
        return sidebar.compose(snap, width)["w1:p1"]["fm_meta"]

    def test_no_glyph_without_pressure_or_when_ok(self):
        base = self.cost_row(None)
        self.assertNotIn("⚠", base)
        self.assertEqual(self.cost_row({"level": "ok", "reasons": []}), base)

    def test_glyph_and_reasons_when_high_or_critical(self):
        row = self.cost_row({"level": "high", "reasons": ["load", "mem"]})
        self.assertIn(" ⚠ load,mem", row)
        self.assertIn("$0.47 ⚠", row)
        self.assertIn("⚠ disk", self.cost_row({"level": "critical", "reasons": ["disk"]}))

    def test_row_fits_the_width(self):
        for width in (20, 24, 34, 40):
            row = self.cost_row({"level": "high", "reasons": ["load", "mem", "disk"]}, width)
            self.assertLessEqual(sidebar.cell_width(row), width - sidebar.INSET)


class RadarPressure(tr.Fixture):
    def doc(self):
        syms = fr.load_symbols("unicode")
        return fr.json_doc(self.snap(), tr.NOW, "unicode", syms)

    def test_pressure_is_carried_only_when_not_ok(self):
        d = tr.live("s1", "a", "fm-a")
        d["pressure"] = {"level": "high", "reasons": ["mem"]}
        self.put_live(d)
        self.assertEqual(self.doc()["roots"][0]["pressure"], {"level": "high", "reasons": ["mem"]})

    def test_absent_or_ok_pressure_is_omitted(self):
        d = tr.live("s1", "a", "fm-a")
        self.put_live(d)
        self.assertNotIn("pressure", self.doc()["roots"][0])
        d["pressure"] = {"level": "ok", "reasons": []}
        self.put_live(d)
        self.assertNotIn("pressure", self.doc()["roots"][0])


class RetroPressure(unittest.TestCase):
    def test_counts_and_line(self):
        trace = [{"event": "launch_deferred"}, {"event": "launch_narrowed"}, {"event": "launch_narrowed"}]
        rep = retro.build(None, trace, None, None, 5, str(HERE))
        self.assertEqual((rep["trace"]["launch_deferred"], rep["trace"]["launch_narrowed"]), (1, 2))
        self.assertIn("pressure: deferred 1, narrowed 2", retro.render_text(rep))

    def test_line_omitted_when_both_zero(self):
        rep = retro.build(None, [{"event": "turn"}], None, None, 5, str(HERE))
        self.assertNotIn("pressure:", retro.render_text(rep))


if __name__ == "__main__":
    unittest.main()
