"""A plan-first child brief asks for the `## Summary` section at the top of plan.md (the old `## For the owner` stays accepted by the harness)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_foreman_session as base

fsn = base.fsn


class OwnerSectionNoteTest(unittest.TestCase):
    def test_plan_first_footer_asks_for_the_owner_section(self):
        text = fsn.footer("demo", True)
        self.assertIn("## Summary", text)
        self.assertLess(text.index("## Summary"), text.index("## Decisions and assumptions"))
        self.assertNotIn("## For the owner", text)

    def test_plan_first_footer_points_at_the_owner_text_rule(self):
        text = fsn.footer("demo", True)
        self.assertIn("as owner text (your owner-text rule)", text)
        self.assertNotIn("in plain words", text)

    def test_non_plan_footer_does_not(self):
        self.assertNotIn("## Summary", fsn.footer("demo", False))

    def test_remote_footer_names_the_old_heading_for_an_older_harness(self):
        text = fsn.remote_footer("demo", True)
        self.assertIn("## Summary", text)
        self.assertIn("refuses the plan as `missing` is older: use `## For the owner` there", text)
        self.assertNotIn("is older", fsn.footer("demo", True))


if __name__ == "__main__":
    unittest.main()
