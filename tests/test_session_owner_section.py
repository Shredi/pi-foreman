"""A plan-first child brief asks for the `## For the owner` section at the top of plan.md."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_foreman_session as base  # noqa: E402

fsn = base.fsn


class OwnerSectionNoteTest(unittest.TestCase):
    def test_plan_first_footer_asks_for_the_owner_section(self):
        text = fsn.footer("demo", True)
        self.assertIn("## For the owner", text)
        self.assertLess(text.index("## For the owner"), text.index("## Decisions and assumptions"))

    def test_non_plan_footer_does_not(self):
        self.assertNotIn("## For the owner", fsn.footer("demo", False))


if __name__ == "__main__":
    unittest.main()
