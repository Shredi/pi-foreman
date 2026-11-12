"""The child rules text names both PR watch report lines: ready to merge, and green but still a draft."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_session as fsn  # noqa: E402


class FooterDraftReportTests(unittest.TestCase):
    def test_footer_names_the_still_a_draft_report_line(self):
        for plan_first in (False, True):
            text = " ".join(fsn.footer("demo", plan_first).split())
            self.assertIn("`PR #n green on <sha>, mergeable, still a draft`", text)
            self.assertIn("`PR #n green on <sha>, mergeable, ready to merge`", text)


if __name__ == "__main__":
    unittest.main()
