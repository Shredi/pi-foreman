"""No session merges a PR: the foreman rules, the reviewer rules and both brief footers say work ends at ready, name no way of merging."""
from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_session as fsn  # noqa: E402


def flat(text):
    return " ".join(text.split())


class NoSessionMergesTests(unittest.TestCase):
    def test_foreman_rules_end_work_at_ready_and_name_no_merge_command(self):
        text = flat((ROOT / "instructions" / "foreman.md").read_text(encoding="utf-8"))
        self.assertIn("Your work on a PR ends at ready", text)
        self.assertIn("No session merges a PR, its own or a child's", text)
        self.assertIn("The watch tells you when it is merged", text)
        self.assertIn("wait for the merge, or `pr_unwatch`", text)
        self.assertNotIn("merge a PR that is green", text)
        self.assertNotIn("Merge fast", text)
        self.assertNotIn("merge it, or", text)
        for way in ("gh pr merge", "glab mr merge", "auto-merge", "squash"):
            self.assertNotIn(way, text)

    def test_reviewer_rules_do_not_say_who_merges(self):
        text = (ROOT / "instructions" / "reviewer.md").read_text(encoding="utf-8")
        self.assertIn("a green PR lands without a rerun", text)
        self.assertNotIn("the foreman merges", text)

    def test_local_footer_waits_after_the_report(self):
        for plan_first in (False, True):
            text = flat(fsn.footer("demo", plan_first))
            self.assertIn("Report it once, then wait: no session merges a PR, and the watch reports the merge", text)
            self.assertIn("A review or comment that arrives meanwhile is feedback", text)

    def test_remote_footer_carries_the_pr_paragraph_with_the_update_notice(self):
        for plan_first in (False, True):
            text = flat(fsn.remote_footer("demo", plan_first))
            self.assertIn("your work on a PR ends at ready", text)
            self.assertIn("append the watch's line under `## Update` in `result.md`", text)
            self.assertIn("run the `update` command; then wait", text)
            self.assertIn("No session merges a PR, and the watch reports the merge", text)
            self.assertIn("A review or comment that arrives meanwhile is feedback", text)
            self.assertIsNone(re.search(r"remote notice \S*merge", text))


if __name__ == "__main__":
    unittest.main()
