"""The handoff skill is wired into the session footers and credited in NOTICE."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_session as fsn  # noqa: E402


class HandoffSkillWiringTests(unittest.TestCase):
    def test_footer_names_the_handoff_skill(self):
        self.assertIn("per the `handoff`", fsn.footer("demo", False))

    def test_remote_footer_names_the_handoff_skill(self):
        self.assertIn("per the `handoff`", fsn.remote_footer("demo", False, 32768))

    def test_notice_credits_the_upstream_author(self):
        notice = (Path(__file__).resolve().parent.parent / "NOTICE").read_text(encoding="utf-8")
        self.assertIn("Copyright (c) 2026 Matt Pocock", notice)


if __name__ == "__main__":
    unittest.main()
