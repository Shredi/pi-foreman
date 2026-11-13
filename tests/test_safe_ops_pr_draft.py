"""The pr_draft op of scripts/pr_ops.py (draft state of an owned PR): `gh pr ready` / `--undo`, GitHub only, never model-facing."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_safe_ops_pr as pr_base  # noqa: E402
from test_safe_ops import safe_ops  # noqa: E402


class DraftTest(pr_base.PrCase):
    def draft(self, args, pr_host="auto"):
        return safe_ops.handle({"op": "pr_draft", "args": args, "cwd": self.repo, "config": {"prHost": pr_host}})

    def test_op_is_allowlisted(self):
        self.assertIn("pr_draft", safe_ops.PR_OPS)

    def test_draft_off_runs_gh_pr_ready_with_the_repo_and_host(self):
        self.hosts("gh")
        self.scn({"gh pr ready": {"stdout": ""}})
        res = self.ok(self.draft({"number": 7, "repo": "own/repo", "host": "ghe.example.com", "draft": False}))
        self.assertEqual((res["number"], res["draft"]), (7, False))
        self.assertEqual(self.calls()[0]["argv"], ["gh", "pr", "ready", "7", "-R", "ghe.example.com/own/repo"])

    def test_draft_on_adds_undo(self):
        self.hosts("gh")
        self.scn({"gh pr ready": {"stdout": ""}})
        self.ok(self.draft({"number": 7, "repo": "own/repo", "host": "github.com", "draft": True}))
        self.assertEqual(self.calls()[0]["argv"], ["gh", "pr", "ready", "7", "-R", "github.com/own/repo", "--undo"])

    def test_glab_host_is_unsupported_and_nothing_runs(self):
        self.hosts("glab")
        self.scn({})
        self.refused(self.draft({"number": 7, "repo": "own/repo", "draft": True}, "glab"), "pr_unsupported")
        self.assertEqual(self.calls(), [])

    def test_template_host_is_unsupported_and_nothing_runs(self):
        self.hosts("gh")
        self.refused(self.draft({"number": 7, "repo": "own/repo", "draft": False}, {"create": "mytool create"}), "pr_unsupported")
        self.assertEqual(self.calls(), [])

    def test_bad_arguments_are_refused_before_the_host(self):
        self.hosts("gh")
        self.scn({"gh pr ready": {"stdout": ""}})
        self.refused(self.draft({"repo": "own/repo", "draft": True}), "bad_request")
        self.refused(self.draft({"number": 7, "repo": "own/repo", "draft": "yes"}), "bad_request")
        self.refused(self.draft({"number": 7, "repo": "own/repo"}), "bad_request")
        self.refused(self.draft({"number": 7, "host": "ghe.example.com", "draft": True}), "bad_request")
        self.assertEqual(self.calls(), [])

    def test_a_failing_host_is_an_error_not_a_crash(self):
        self.hosts("gh")
        self.scn({"gh pr ready": {"stderr": "unknown flag: --undo\n", "exit": 1}})
        res = self.draft({"number": 7, "repo": "own/repo", "draft": True})
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], "pr_host_failed")


if __name__ == "__main__":
    unittest.main()
