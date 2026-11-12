"""The child rules text tells a child to report the watch's line when the checks passed but a review or a branch rule holds the PR back."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_session as fsn  # noqa: E402


class FooterHeldBackReportTests(unittest.TestCase):
    def test_footer_names_the_watch_line_for_a_held_back_pr(self):
        for plan_first in (False, True):
            text = " ".join(fsn.footer("demo", plan_first).split())
            self.assertIn(
                "when the checks passed but a review or a branch rule holds the PR back, the line the watch gives", text)
            self.assertIn("`PR #n green on <sha>, mergeable, still a draft`", text)
            self.assertIn("`PR #n green on <sha>, mergeable, ready to merge`", text)


if __name__ == "__main__":
    unittest.main()
