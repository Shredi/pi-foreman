"""Retro sizing block: launch_sizing events joined to later climbs and review FAILs (heuristic)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "scripts"))

import _isolation  # noqa: E402,F401
import foreman_retro as retro  # noqa: E402

TRACE = [
    {"event": "launch_sizing", "role": "builder", "rule": "small", "rung": "default"},
    {"event": "rung_up", "role": "builder", "reason": "context"},
    {"event": "launch_sizing", "role": "builder", "rule": "small", "rung": "default"},
    {"event": "review_done", "role": "reviewer", "decision": "fail"},
    {"event": "launch_sizing", "role": "builder", "rule": "modules", "rung": "strong"},
    {"event": "rung_up", "role": "builder", "reason": "sizing"},
    {"event": "review_done", "role": "reviewer", "decision": "pass"},
    {"event": "launch_sizing", "role": "builder", "rule": "risk_top", "rung": "top"},
    {"event": "rung_top", "role": "builder", "reason": "review_fail"},
    {"event": "review_done", "role": "reviewer", "decision": "fail"},
]


class RetroSizing(unittest.TestCase):
    def test_per_rule_counts(self):
        m = retro.sizing_metrics(TRACE)
        self.assertEqual(m["small"], {"launches": 2, "rungs": {"default": 2}, "climbs": 1, "fails": 1})
        self.assertEqual(m["modules"], {"launches": 1, "rungs": {"strong": 1}, "climbs": 0, "fails": 0})
        self.assertEqual(m["risk_top"], {"launches": 1, "rungs": {"top": 1}, "climbs": 1, "fails": 1})

    def test_none_without_events(self):
        self.assertIsNone(retro.sizing_metrics([{"event": "rung_up"}]))
        self.assertIsNone(retro.sizing_metrics(None))

    def test_rendered_block(self):
        rep = {"session": None, "review": None, "trace": None, "usage": None, "explorer": None, "cache": None,
               "sizing": retro.sizing_metrics(TRACE), "session_tools": None, "proposals": None}
        text = retro.render_text(rep)
        self.assertIn("sizing (heuristic join)", text)
        self.assertIn("small: 2 launches, rung default=2, climbs 1, fails 1", text)


if __name__ == "__main__":
    unittest.main()
