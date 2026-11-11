"""scripts/foreman_worktree.py sweep never removes a worktree holding the default or a protected branch."""
from __future__ import annotations

import contextlib
import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_worktree as fw  # noqa: E402


def g(cwd, *args):
    r = subprocess.run(["git", "-c", "user.name=T", "-c", "user.email=t@example.invalid"] + list(args), cwd=str(cwd),
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    return r.stdout.decode().strip()


class DefaultBranchSweepTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="sweep_default_")))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        patch = mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})
        patch.start()
        self.addCleanup(patch.stop)
        self.state = self.tmp / "agent" / "pi-foreman" / "state"
        self.state.mkdir(parents=True)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        g(self.repo, "init", "-q")
        (self.repo / "README").write_text("x\n")
        g(self.repo, "add", "README")
        g(self.repo, "commit", "-q", "-m", "init")
        g(self.repo, "branch", "-M", "main")
        g(self.repo, "switch", "-q", "-c", "work")  # the main checkout leaves `main` free for a linked worktree

    def wt(self, name, branch=None, detach=False):
        path = self.tmp / "repo.worktrees" / name
        if detach:
            g(self.repo, "worktree", "add", "-q", "--detach", str(path))
        elif branch in self.branches():
            g(self.repo, "worktree", "add", "-q", str(path), branch)
        else:
            g(self.repo, "worktree", "add", "-q", "-b", branch, str(path))
        return path

    def branches(self):
        return set(g(self.repo, "branch", "--list", "--format=%(refname:short)").split())

    def sweep(self, *extra):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = fw.main(["sweep", "--cwd", str(self.repo), "--state", str(self.state), "--session", "s"] + list(extra))
        self.assertEqual(code, 0)
        return out.getvalue().splitlines()

    def skipped(self, lines, path, prefix):
        return any(ln.startswith("skipped: %s — %s" % (path, prefix)) for ln in lines)

    def test_default_branch_worktree_is_kept(self):
        main_wt, rnd = self.wt("main", "main"), self.wt("round", "round")
        lines = self.sweep()
        self.assertTrue(self.skipped(lines, main_wt, "default_branch (main"), lines)
        self.assertTrue(main_wt.is_dir())
        self.assertIn("main", self.branches())
        self.assertIn("removed: %s" % rnd, lines)  # a normal merged round worktree still goes
        self.assertFalse(rnd.exists())
        self.assertNotIn("round", self.branches())

    def test_default_branch_worktree_dry_run(self):
        main_wt = self.wt("main", "main")
        lines = self.sweep("--dry-run")
        self.assertTrue(self.skipped(lines, main_wt, "default_branch (main"), lines)
        self.assertNotIn("would remove: %s" % main_wt, lines)
        self.assertTrue(main_wt.is_dir())
        self.assertIn("main", self.branches())

    def test_unresolved_remote_default_counts_master(self):
        g(self.repo, "branch", "master")
        wt = self.wt("master", "master")
        lines = self.sweep()
        self.assertTrue(self.skipped(lines, wt, "default_branch (master); remote default unresolved, main and master count"), lines)
        self.assertTrue(wt.is_dir())
        self.assertIn("master", self.branches())

    def test_remote_default_with_another_name(self):
        g(self.repo, "update-ref", "refs/remotes/origin/trunk", "main")
        g(self.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
        g(self.repo, "branch", "trunk")
        wt = self.wt("trunk", "trunk")
        lines = self.sweep()
        self.assertIn("skipped: %s — default_branch (trunk)" % wt, lines)
        self.assertTrue(wt.is_dir())
        self.assertIn("trunk", self.branches())

    def test_configured_base_branch(self):
        g(self.repo, "branch", "develop")
        wt = self.wt("develop", "develop")
        cfg = {"safety": {"ops": {"baseBranch": "develop"}, "git": {"protectedBranches": []}}}
        lines = fw.sweep(str(self.repo), cfg, str(self.state), "s")
        self.assertTrue(self.skipped(lines, wt, "default_branch (develop)"), lines)
        self.assertTrue(wt.is_dir())
        self.assertIn("develop", self.branches())

    def test_protected_pattern(self):
        g(self.repo, "branch", "release/1")
        wt = self.wt("rel", "release/1")
        cfg = {"safety": {"git": {"protectedBranches": ["release/*"]}}}
        for dry in (True, False):
            lines = fw.sweep(str(self.repo), cfg, str(self.state), "s", dry)
            self.assertIn("skipped: %s — protected_branch (release/*)" % wt, lines)
            self.assertNotIn("would remove: %s" % wt, lines)
            self.assertTrue(wt.is_dir())
            self.assertIn("release/1", self.branches())

    def test_stale_origin_head_counts_main_and_master(self):
        g(self.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")  # target does not exist
        wt = self.wt("main", "main")
        cfg = {"safety": {"git": {"protectedBranches": []}}}
        for dry in (True, False):
            lines = fw.sweep(str(self.repo), cfg, str(self.state), "s", dry)
            self.assertTrue(self.skipped(lines, wt, "default_branch (main); remote default unresolved, main and master count"), lines)
            self.assertNotIn("would remove: %s" % wt, lines)
            self.assertTrue(wt.is_dir())
            self.assertIn("main", self.branches())

    def test_remote_base_shadowed_by_local_branch_of_same_name(self):
        g(self.repo, "update-ref", "refs/remotes/origin/x", "main")
        g(self.repo, "branch", "origin/x")
        g(self.repo, "branch", "x")
        wt = self.wt("x", "x")
        cfg = {"safety": {"ops": {"baseBranch": "origin/x"}, "git": {"protectedBranches": []}}}
        for dry in (True, False):
            lines = fw.sweep(str(self.repo), cfg, str(self.state), "s", dry)
            self.assertTrue(self.skipped(lines, wt, "default_branch (x)"), lines)
            self.assertNotIn("would remove: %s" % wt, lines)
            self.assertTrue(wt.is_dir())
            self.assertIn("x", self.branches())

    def test_base_branch_with_remotes_prefix(self):
        g(self.repo, "update-ref", "refs/remotes/origin/develop", "main")
        g(self.repo, "branch", "develop")
        wt = self.wt("develop", "develop")
        cfg = {"safety": {"ops": {"baseBranch": "remotes/origin/develop"}, "git": {"protectedBranches": []}}}
        for dry in (True, False):
            lines = fw.sweep(str(self.repo), cfg, str(self.state), "s", dry)
            self.assertTrue(self.skipped(lines, wt, "default_branch (develop)"), lines)
            self.assertTrue(wt.is_dir())
            self.assertIn("develop", self.branches())

    def test_base_branch_named_with_heads_prefix(self):
        g(self.repo, "branch", "heads/foo")
        wt = self.wt("foo", "heads/foo")
        cfg = {"safety": {"ops": {"baseBranch": "heads/foo"}, "git": {"protectedBranches": []}}}
        for dry in (True, False):
            lines = fw.sweep(str(self.repo), cfg, str(self.state), "s", dry)
            self.assertTrue(self.skipped(lines, wt, "default_branch (heads/foo)"), lines)
            self.assertNotIn("would remove: %s" % wt, lines)
            self.assertTrue(wt.is_dir())
            self.assertIn("heads/foo", self.branches())

    def test_unresolved_remote_default_counts_master_with_local_main_present(self):
        g(self.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")  # stale
        g(self.repo, "branch", "master")
        wt = self.wt("master", "master")
        cfg = {"safety": {"git": {"protectedBranches": []}}}
        for dry in (True, False):
            lines = fw.sweep(str(self.repo), cfg, str(self.state), "s", dry)
            self.assertTrue(self.skipped(lines, wt, "default_branch (master); remote default unresolved, main and master count"), lines)
            self.assertTrue(wt.is_dir())
            self.assertIn("master", self.branches())

    def test_checked_branch_that_differs_from_listing_is_skipped(self):
        wt = self.wt("round", "round")
        chk = {"target": str(wt), "main_dir": str(self.repo), "branch": "main", "head": "x"}
        for dry in (True, False):
            with mock.patch.object(fw.safe_ops, "check_worktree", return_value=chk), \
                    mock.patch.object(fw.safe_ops, "remove_worktree") as rm:
                lines = fw.sweep(str(self.repo), {}, str(self.state), "s", dry)
            rm.assert_not_called()
            self.assertTrue(self.skipped(lines, wt, "default_branch (main"), lines)
            self.assertTrue(wt.is_dir())
            self.assertIn("round", self.branches())

    def test_detached_worktree_is_removed(self):
        wt = self.wt("detached", detach=True)
        before = self.branches()
        lines = self.sweep()
        self.assertIn("removed: %s" % wt, lines)
        self.assertFalse(wt.exists())
        self.assertEqual(self.branches(), before)


if __name__ == "__main__":
    unittest.main()
