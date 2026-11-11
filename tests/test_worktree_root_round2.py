"""Round-2 fixes of the worktree-root work: sweep never removes a worktree held by another checkout,
create_worktree reports a package.json without a lockfile."""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
import _isolation  # noqa: E402,F401
import foreman_session as fsn  # noqa: E402
import foreman_worktree as fw  # noqa: E402
from _submodules import build_rig, git  # noqa: E402


@unittest.skipIf(os.name == "nt", "POSIX paths")
class SweepFromSubmoduleTest(unittest.TestCase):
    def setUp(self):
        self.base = os.path.realpath(tempfile.mkdtemp(prefix="sweep_sub_"))
        self.addCleanup(shutil.rmtree, self.base, True)
        self.rig = build_rig(self.base)
        self.state = os.path.join(self.base, "state")
        os.makedirs(self.state)
        p = mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})
        p.start()
        self.addCleanup(p.stop)

    def test_sweep_from_a_submodule_checkout_never_removes_the_nested_worktree(self):
        r = self.rig
        sub_main = os.path.join(r.superproject, "libs", "a")
        lines = fw.sweep(sub_main, {}, self.state, "sess-x", False)
        self.assertTrue(os.path.isdir(r.linked_sub), lines)
        self.assertFalse([l for l in lines if l.startswith("removed:")], lines)
        self.assertTrue(any(l.startswith("skipped: %s" % r.linked_sub) and "nested_worktree" in l for l in lines), lines)

    def test_sweep_really_runs_on_a_plain_repo_and_dry_run_keeps_the_worktree(self):
        work = os.path.join(self.base, "plain")
        os.makedirs(work)
        git(work, "init", "-q", "-b", "main")
        Path(work, "f").write_text("x\n")
        git(work, "add", "f")
        git(work, "commit", "-q", "-m", "i")
        wt = os.path.join(self.base, "plain.worktrees", "r1")
        git(work, "worktree", "add", "-q", "-b", "r1", wt)
        lines = fw.sweep(work, {}, self.state, "sess-x", True)
        self.assertTrue(os.path.isdir(wt))
        self.assertIn("would remove: %s" % wt, lines)


@unittest.skipIf(os.name == "nt", "POSIX paths and symlinks")
class CreateWorktreeInstallNoteTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cw_note_")).resolve()
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-q", "-b", "main")

    def make(self, files, n):
        for name in files:
            (self.repo / name).write_text("{}\n")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "c%d" % n, "--allow-empty")
        plan = {"repo": str(self.repo), "path": str(self.tmp / ("wt%d" % n)), "branch": "b%d" % n, "base": "HEAD"}
        with mock.patch.object(fsn, "run_npm_ci", return_value=0) as npm:
            return fsn.create_worktree(plan), npm

    def test_lockfile_runs_npm_ci(self):
        info, npm = self.make(["package.json", "package-lock.json"], 1)
        self.assertEqual(info["install"], "npm ci")
        npm.assert_called_once()

    def test_package_json_without_lockfile_is_skipped_with_a_note(self):
        info, npm = self.make(["package.json"], 2)
        self.assertIn("skipped", info["install"])
        self.assertIn("lockfile", info["install"])
        npm.assert_not_called()

    def test_no_package_json_installs_nothing(self):
        info, npm = self.make(["readme.txt"], 3)
        self.assertEqual(info["install"], "none")
        npm.assert_not_called()


if __name__ == "__main__":
    unittest.main()
