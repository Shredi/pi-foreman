"""D93: an untracked (not ignored) archived `.workflow/` at the worktree top level is not a change; the repository may come
from an absolute worktree path when the session cwd is no git work tree (temp repos only)."""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_safe_ops_ignored_files import g, put, safe_ops


class RepoCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="wf_untracked_test_")))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        patch = mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})
        patch.start()
        self.addCleanup(patch.stop)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        g(self.repo, "init", "-q", "-b", "main")
        put(self.repo, "README")  # no .gitignore: `.workflow/` shows as `?? .workflow/`
        g(self.repo, "add", ".")
        g(self.repo, "commit", "-q", "-m", "init")
        self.wt = self.tmp / "wt"
        g(self.repo, "worktree", "add", "-q", "-b", "feat", str(self.wt))
        self.cfg = safe_ops.ops_config({})


class UntrackedWorkflowTest(RepoCase):
    def check(self, top_level=(".workflow",), **kw):
        return safe_ops.check_worktree(str(self.wt), str(self.wt), self.cfg, top_level=top_level, **kw)

    def refused(self, name="worktree_dirty", **kw):
        with self.assertRaises(safe_ops.Precondition) as cm:
            self.check(**kw)
        self.assertEqual(cm.exception.name, name)
        return cm.exception

    def test_untracked_workflow_passes_with_the_exemption_and_is_removed(self):
        put(self.wt, ".workflow/LEDGER.md")
        put(self.wt, ".workflow/scratch/plan.md")
        chk = self.check()
        self.assertEqual(chk["untracked"], [".workflow/"])
        res = safe_ops.remove_worktree(chk)
        self.assertFalse(self.wt.exists())
        self.assertTrue(res["branchDeleted"])

    def test_without_the_exemption_it_still_refuses(self):
        put(self.wt, ".workflow/LEDGER.md")
        self.refused(top_level=())

    def test_nested_repository_at_any_depth_refuses(self):
        put(self.wt, ".workflow/LEDGER.md")
        put(self.wt, ".workflow/sub/deep/.git/HEAD")
        self.refused()
        self.assertTrue(self.wt.exists())

    def test_nested_git_file_refuses(self):
        put(self.wt, ".workflow/LEDGER.md")
        put(self.wt, ".workflow/sub/.git", "gitdir: x\n")
        self.refused()

    def test_over_the_walk_cap_refuses(self):
        for n in range(4):
            put(self.wt, ".workflow/f%d" % n)
        with mock.patch.object(safe_ops, "IGNORED_WALK_CAP", 3):
            self.refused()

    def test_another_untracked_file_refuses(self):
        put(self.wt, ".workflow/LEDGER.md")
        put(self.wt, "notes.txt")
        self.refused()

    def test_nested_workflow_folder_refuses(self):
        put(self.wt, "sub/.workflow/LEDGER.md")
        self.refused()

    def test_tracked_change_under_workflow_refuses(self):
        put(self.wt, ".workflow/keep.md")
        g(self.wt, "add", "-f", ".workflow/keep.md")
        g(self.wt, "commit", "-q", "-m", "track")
        put(self.wt, ".workflow/keep.md", "changed\n")
        self.refused()


class RepoFromPathTest(RepoCase):
    """check_worktree from a session cwd outside any git work tree."""

    def setUp(self):
        super().setUp()
        self.plain = self.tmp / "plain"
        self.plain.mkdir()

    def test_absolute_path_names_the_repository(self):
        chk = safe_ops.check_worktree(str(self.plain), str(self.wt), self.cfg)
        self.assertEqual((chk["target"], chk["branch"]), (str(self.wt), "feat"))
        res = safe_ops.remove_worktree(chk)
        self.assertEqual(res["path"], str(self.wt))
        self.assertFalse(self.wt.exists())

    def test_relative_path_still_refuses(self):
        for raw in ("../wt", "wt"):
            with self.assertRaises(safe_ops.Precondition) as cm:
                safe_ops.check_worktree(str(self.plain), raw, self.cfg)
            self.assertEqual(cm.exception.name, "not_a_git_repo")

    def test_main_worktree_is_still_never_removed(self):
        with self.assertRaises(safe_ops.Precondition) as cm:
            safe_ops.check_worktree(str(self.plain), str(self.repo), self.cfg)
        self.assertEqual(cm.exception.name, "main_worktree")

    def test_absolute_path_outside_any_repository_refuses(self):
        other = self.tmp / "other"
        other.mkdir()
        with self.assertRaises(safe_ops.Precondition) as cm:
            safe_ops.check_worktree(str(self.plain), str(other), self.cfg)
        self.assertEqual(cm.exception.name, "not_a_git_repo")

    def test_session_inside_another_repository_keeps_its_refusal(self):
        other = self.tmp / "other"
        other.mkdir()
        g(other, "init", "-q", "-b", "main")
        with self.assertRaises(safe_ops.Precondition) as cm:
            safe_ops.check_worktree(str(other), str(self.wt), self.cfg)
        self.assertEqual(cm.exception.name, "not_linked_worktree")


if __name__ == "__main__":
    unittest.main()
