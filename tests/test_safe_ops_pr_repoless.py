"""D93 (B): pr_status and pr_checks take the top-level `repoless` with `args.repo` like pr_comments (fake gh)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_safe_ops_pr import GH_CHECKS, GH_STATUS, RepoLessCase, j, safe_ops  # noqa: E402


class RepolessStatusChecksTest(RepoLessCase):
    def setUp(self):
        super().setUp()
        self.scn({"gh pr view 7": {"stdout": j(GH_STATUS)}, "gh pr checks": {"stdout": j(GH_CHECKS), "exit": 8}})

    def req(self, op, cwd=None, repoless=True, **args):
        r = {"op": op, "args": args, "cwd": cwd or self.plain, "config": {"prHost": "gh"}}
        if repoless is not None:
            r["repoless"] = repoless
        return safe_ops.handle(r)

    def test_status_with_repo_runs_outside_a_checkout(self):
        res = self.ok(self.req("pr_status", number=7, repo="acme/lib", host="github.com"))
        self.assertEqual(res["state"], "open")
        self.assertIn("github.com/acme/lib", self.calls()[0]["argv"])

    def test_checks_with_repo_runs_outside_a_checkout(self):
        res = self.ok(self.req("pr_checks", number=7, repo="acme/lib", host="github.com"))
        self.assertEqual([len(res[k]) for k in ("pending", "failed", "passed")], [1, 1, 1])

    def test_without_repoless_or_repo_the_old_rule_applies(self):
        for op in ("pr_status", "pr_checks"):
            self.refused(self.req(op, repoless=None, number=7, repo="acme/lib"), "not_a_git_repo")
            self.refused(self.req(op, repoless="yes", number=7, repo="acme/lib"), "not_a_git_repo")
            self.refused(self.req(op, number=7), "not_a_git_repo")


if __name__ == "__main__":
    unittest.main()
