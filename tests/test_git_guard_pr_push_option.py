"""Push-option PR forms accept only a PASS on the commit being pushed, never its remote counterpart."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import git_guard as gg  # noqa: E402
import test_git_guard_pr_gate_head as head_tests  # noqa: E402

CMD = "git push -o merge_request.create origin round/x"


class PushOptionHeadTest(unittest.TestCase):
    setUp = head_tests.PrGateHeadTest.setUp
    tearDown = head_tests.PrGateHeadTest.tearDown
    git = head_tests.PrGateHeadTest.git
    commit = head_tests.PrGateHeadTest.commit
    decide = head_tests.PrGateHeadTest.decide

    def test_pass_only_on_remote_with_unreviewed_local_is_denied(self):
        pushed = self.commit(self.wt, "feat: x")
        self.git(self.wt, "push", "-q", "origin", "round/x")
        self.commit(self.wt, "feat: newer, unreviewed")
        d = self.decide(CMD, self.wt, [pushed])
        self.assertEqual(d.level, gg.DENY)
        self.assertIn("pr_refused:stale_review", d.reason)

    def test_pass_on_local_commit_allows(self):
        self.commit(self.wt, "feat: x")
        self.git(self.wt, "push", "-q", "origin", "round/x")
        newer = self.commit(self.wt, "feat: newer")
        self.assertEqual(self.decide(CMD, self.wt, [newer]).level, gg.ALLOW)


if __name__ == "__main__":
    unittest.main()
