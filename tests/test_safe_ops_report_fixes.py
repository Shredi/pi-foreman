"""worktree_remove: the verified-merged fact (D7) and disposable untracked paths (D16), in the tool op, sweep and close cleanup."""
from __future__ import annotations

import contextlib
import io
import os
import shutil
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_safe_ops as base  # noqa: E402
import foreman_close as fcl  # noqa: E402
import foreman_worktree as fw  # noqa: E402
import safe_ops  # noqa: E402


class WorktreeCase(base.SafeOpsCase):
    def add_worktree(self, name="wt", branch="feat"):
        path = os.path.join(self.tmp, name)
        self.git("worktree", "add", "-q", "-b", branch, path)
        return path

    def branches(self):
        return self.git("branch", "--format=%(refname:short)").split()

    def request(self, wt, **extra):
        return safe_ops.handle({"op": "worktree_remove", "args": {"path": wt}, "cwd": self.repo, "config": extra.pop("config", {}), **extra})

    def squash_merged(self):
        """A worktree whose branch was squash-merged: its tip is not in main."""
        wt = self.add_worktree()
        self.write("f.txt", "x", base=wt)
        self.git("add", "f.txt", cwd=wt)
        self.git("commit", "-q", "-m", "work", cwd=wt)
        self.write("f.txt", "x")
        self.git("add", "f.txt")
        self.git("commit", "-q", "-m", "squash")
        return wt, self.git("rev-parse", "HEAD", cwd=wt).strip()


class VerifiedMergedTest(WorktreeCase):
    def test_fact_removes_a_squash_merged_branch(self):
        wt, head = self.squash_merged()
        self.failed(self.request(wt), "not_merged")
        res = self.request(wt, verifiedMerged=head, verifiedBranch="feat")
        self.assertTrue(res["ok"], res)
        self.assertEqual((res["branch"], res["branchDeleted"]), ("feat", True))
        self.assertFalse(os.path.exists(wt))
        self.assertNotIn("feat", self.branches())

    def test_stale_sha_is_refused(self):
        wt, head = self.squash_merged()
        other = self.git("rev-parse", "HEAD").strip()
        self.assertNotEqual(other, head)
        self.failed(self.request(wt, verifiedMerged=other, verifiedBranch="feat"), "verified_merged_stale")
        self.assertTrue(os.path.isdir(wt))
        self.assertIn("feat", self.branches())

    def test_moved_head_is_refused(self):
        wt, head = self.squash_merged()
        self.write("g.txt", "y", base=wt)
        self.git("add", "g.txt", cwd=wt)
        self.git("commit", "-q", "-m", "more", cwd=wt)
        self.failed(self.request(wt, verifiedMerged=head, verifiedBranch="feat"), "verified_merged_stale")

    def test_key_in_args_is_ignored(self):
        wt, head = self.squash_merged()
        res = safe_ops.handle({"op": "worktree_remove", "args": {"path": wt, "verifiedMerged": head, "verifiedBranch": "feat"}, "cwd": self.repo, "config": {}})
        self.failed(res, "not_merged")
        self.assertTrue(os.path.isdir(wt))

    def test_default_branch_is_refused(self):
        wt, head = self.squash_merged()
        self.failed(self.request(wt, config={"baseBranch": "feat"}, verifiedMerged=head, verifiedBranch="feat"), "default_branch")
        self.assertTrue(os.path.isdir(wt))

    def test_other_verified_branch_is_refused(self):
        wt, head = self.squash_merged()
        self.failed(self.request(wt, verifiedMerged=head, verifiedBranch="other"), "branch_mismatch")
        self.assertIn("feat", self.branches())

    def test_unmerged_without_the_key_stays_refused(self):
        wt, _ = self.squash_merged()
        self.failed(self.request(wt), "not_merged")
        self.assertTrue(os.path.isdir(wt))


class DisposableUntrackedTest(WorktreeCase):
    def test_untracked_disposable_folder_is_removed(self):
        wt = self.add_worktree()
        self.write("build/out.js", "x", base=wt)
        self.write("dist/a/b.js", "x", base=wt)
        res = self.request(wt)
        self.assertTrue(res["ok"], res)
        self.assertFalse(os.path.exists(wt))

    def test_another_untracked_file_still_refuses(self):
        wt = self.add_worktree()
        self.write("build/out.js", "x", base=wt)
        self.write("notes.txt", "x", base=wt)
        self.failed(self.request(wt), "worktree_dirty")
        self.assertTrue(os.path.isfile(os.path.join(wt, "build", "out.js")))

    def test_tracked_change_still_refuses(self):
        wt = self.add_worktree()
        self.write("build/out.js", "x", base=wt)
        self.write("tracked.txt", "changed\n", base=wt)
        self.failed(self.request(wt), "worktree_dirty")
        self.assertTrue(os.path.isfile(os.path.join(wt, "build", "out.js")))

    def test_symlink_inside_a_matched_folder_is_not_followed(self):
        if not base.SYMLINKS:
            self.skipTest(base.NO_SYMLINK)
        wt = self.add_worktree()
        outside = os.path.join(self.tmp, "outside")
        self.write("keep.txt", "keep", base=outside)
        self.write("build/out.js", "x", base=wt)
        os.symlink(outside, os.path.join(wt, "build", "link"), target_is_directory=True)
        res = self.request(wt)
        self.assertTrue(res["ok"], res)
        self.assertFalse(os.path.exists(wt))
        self.assertEqual(Path(outside, "keep.txt").read_text("utf-8"), "keep")

    def test_matched_symlink_is_unlinked_not_followed(self):
        if not base.SYMLINKS:
            self.skipTest(base.NO_SYMLINK)
        wt = self.add_worktree()
        outside = os.path.join(self.tmp, "outside")
        self.write("keep.txt", "keep", base=outside)
        os.symlink(os.path.join(outside, "keep.txt"), os.path.join(wt, ".DS_Store"))
        res = self.request(wt)
        self.assertTrue(res["ok"], res)
        self.assertFalse(os.path.exists(wt))
        self.assertEqual(Path(outside, "keep.txt").read_text("utf-8"), "keep")

    def test_delete_refuses_a_path_resolving_outside(self):
        if not base.SYMLINKS:
            self.skipTest(base.NO_SYMLINK)
        wt = self.add_worktree()
        outside = os.path.join(self.tmp, "outside")
        self.write("build/x.js", "keep", base=outside)
        os.symlink(outside, os.path.join(wt, "sub"), target_is_directory=True)
        with self.assertRaises(safe_ops.ActionError):
            safe_ops.delete_untracked(wt, ["sub/build/"])
        self.assertTrue(os.path.isfile(os.path.join(outside, "build", "x.js")))

    def test_matched_folder_with_a_nested_repository_refuses(self):
        wt = self.add_worktree()
        os.makedirs(os.path.join(wt, "build"))
        self.git("init", "-q", cwd=os.path.join(wt, "build"))
        self.write("build/out.js", "x", base=wt)
        self.failed(self.request(wt), "worktree_dirty")
        self.assertTrue(os.path.isdir(os.path.join(wt, "build", ".git")))


class SweepAndCloseTest(WorktreeCase):
    def setUp(self):
        super().setUp()
        self.wt = self.add_worktree("repo.worktrees-feat")
        self.write("build/out.js", "x", base=self.wt)
        self.state = os.path.join(self.tmp, "agent", "pi-foreman", "state")
        os.makedirs(self.state)

    def test_sweep_removes_it(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            fw.main(["sweep", "--cwd", self.repo, "--state", self.state, "--session", "s"])
        self.assertIn("removed: %s" % self.wt, out.getvalue().splitlines())
        self.assertFalse(os.path.exists(self.wt))

    def test_close_check_entry_accepts_and_removal_cleans_it(self):
        reason, chk = fcl.check_entry({"path": self.wt, "kind": "worktree"}, self.state, "s", safe_ops.ops_config({}))
        self.assertIsNone(reason)
        safe_ops.remove_worktree(chk)
        self.assertFalse(os.path.exists(self.wt))

    def test_selfclean_removes_it(self):
        info = {}
        reason, chk = fcl.selfclean_check(self.wt, "feat", self.state, "child", safe_ops.ops_config({}), info=info)
        self.assertIsNone(reason, info)
        safe_ops.remove_worktree(chk)
        self.assertFalse(os.path.exists(self.wt))


if __name__ == "__main__":
    unittest.main()
