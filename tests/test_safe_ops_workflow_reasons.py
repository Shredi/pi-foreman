"""D93 follow-up: `workflow_has_git` returns a structured reason, and the untracked `.workflow/` refusal names the
real cause: a nested repository, the walk cap, or a read error."""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_safe_ops_ignored_files import put, safe_ops  # noqa: E402
from test_safe_ops_workflow_untracked import RepoCase  # noqa: E402


class WorkflowHasGitTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(os.path.realpath(tempfile.mkdtemp(prefix="wf_reasons_test_")))
        self.addCleanup(shutil.rmtree, str(self.root), True)

    def test_clean_folder_has_no_reason(self):
        put(self.root, "LEDGER.md")
        put(self.root, "sub/plan.md")
        self.assertIsNone(safe_ops.workflow_has_git(str(self.root)))

    def test_nested_git_at_depth_is_nested(self):
        put(self.root, "sub/deep/.git/HEAD")
        self.assertEqual(safe_ops.workflow_has_git(str(self.root)), safe_ops.WORKFLOW_NESTED)

    def test_over_the_cap_is_too_large(self):
        for n in range(4):
            put(self.root, "f%d" % n)
        with mock.patch.object(safe_ops, "IGNORED_WALK_CAP", 3):
            self.assertEqual(safe_ops.workflow_has_git(str(self.root)), safe_ops.WORKFLOW_TOO_LARGE)

    def test_read_error_is_unreadable(self):
        put(self.root, "LEDGER.md")
        self.assertEqual(safe_ops.workflow_has_git(str(self.root / "missing")), safe_ops.WORKFLOW_UNREADABLE)

    def test_missing_root_is_unreadable_not_clean(self):
        self.assertIsNotNone(safe_ops.workflow_has_git(str(self.root / "absent")))


class WorkflowRefusalWordingTest(RepoCase):
    def refusal(self):
        with self.assertRaises(safe_ops.Precondition) as cm:
            safe_ops.check_worktree(str(self.wt), str(self.wt), self.cfg, top_level=(".workflow",))
        self.assertEqual(cm.exception.name, "worktree_dirty")
        return cm.exception.detail

    def test_nested_repository_keeps_the_nested_wording(self):
        put(self.wt, ".workflow/LEDGER.md")
        put(self.wt, ".workflow/sub/.git", "gitdir: x\n")
        msg = self.refusal()
        self.assertIn("holds a nested repository: .workflow/", msg)

    def test_over_the_cap_says_too_large_not_nested(self):
        for n in range(4):
            put(self.wt, ".workflow/f%d" % n)
        with mock.patch.object(safe_ops, "IGNORED_WALK_CAP", 3):
            msg = self.refusal()
        self.assertIn("untracked .workflow/ too large to check", msg)
        self.assertNotIn("nested", msg)

    def test_read_error_says_could_not_be_read_not_nested(self):
        put(self.wt, ".workflow/LEDGER.md")
        real_scandir = os.scandir

        def denied(path="."):
            if str(path).endswith(".workflow"):
                raise PermissionError(13, "Permission denied", str(path))
            return real_scandir(path)

        with mock.patch.object(safe_ops.os, "scandir", side_effect=denied):
            msg = self.refusal()
        self.assertIn("untracked .workflow/ could not be read", msg)
        self.assertNotIn("nested", msg)


if __name__ == "__main__":
    unittest.main()
