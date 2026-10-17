"""Retro critique counter (r9 item 6): `critique` trace events -> trace metrics and the report line."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "scripts"))

import _isolation  # noqa: E402,F401
import foreman_retro as retro  # noqa: E402


class RetroCritique(unittest.TestCase):
    def test_raised_applied_and_diff_lines_per_round(self):
        trace = [
            {"event": "critique", "kind": "raised", "role": "reviewer", "runId": "r1", "count": 3, "lines": 120},
            {"event": "critique", "kind": "applied", "role": "builder", "count": 2},
            {"event": "critique", "kind": "raised", "role": "reviewer", "runId": "r2", "count": 0, "lines": 14},
            {"event": "critique", "kind": "raised", "role": "senior-reviewer", "runId": "r3", "count": 1},
            {"event": "critique", "kind": "other", "count": 9},
        ]
        rep = retro.build(None, trace, None, None, 5, str(HERE))
        t = rep["trace"]
        self.assertEqual((t["critique_raised"], t["critique_applied"]), (4, 2))
        self.assertEqual(t["critique_rounds"], [{"raised": 3, "lines": 120}, {"raised": 0, "lines": 14}, {"raised": 1, "lines": None}])
        self.assertIn("critique: raised 4, applied 2; per round raised/diff lines: 3/120, 0/14, 1/?", retro.render_text(rep))

    def test_line_omitted_without_a_counted_review(self):
        rep = retro.build(None, [{"event": "turn"}, {"event": "critique", "kind": "applied", "count": 1}], None, None, 5, str(HERE))
        self.assertNotIn("critique:", retro.render_text(rep))


if __name__ == "__main__":
    unittest.main()
