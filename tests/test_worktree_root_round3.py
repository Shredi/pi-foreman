"""Round-3: the sweep skips only worktrees held as a gitlink of another checkout, not every worktree with a git checkout above it."""
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
import foreman_worktree as fw  # noqa: E402
from _submodules import build_rig, git  # noqa: E402


def make_repo(path):
    os.makedirs(path)
    git(path, "init", "-q", "-b", "main")
    Path(path, "f").write_text("x\n")
    git(path, "add", "f")
    git(path, "commit", "-q", "-m", "i")


@unittest.skipIf(os.name == "nt", "POSIX paths")
class SweepNotOverBlockedTest(unittest.TestCase):
    def setUp(self):
        self.base = os.path.realpath(tempfile.mkdtemp(prefix="sweep_r3_"))
        self.addCleanup(shutil.rmtree, self.base, True)
        self.state = os.path.join(self.base, "state")
        os.makedirs(self.state)
        p = mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})
        p.start()
        self.addCleanup(p.stop)

    def test_repo_inside_a_git_parent_folder_is_swept_normally(self):
        parent = os.path.join(self.base, "parent")
        make_repo(parent)
        repo = os.path.join(parent, "repo")
        make_repo(repo)
        wt = os.path.join(parent, "repo.worktrees", "r1")
        git(repo, "worktree", "add", "-q", "-b", "r1", wt)
        lines = fw.sweep(repo, {}, self.state, "sess-x", True)
        self.assertIn("would remove: %s" % wt, lines)

    def test_submodule_checkouts_own_round_worktrees_are_swept_normally(self):
        r = build_rig(self.base)
        sub = os.path.join(r.superproject, "libs", "a")
        wt = os.path.join(r.superproject, "libs", "a.worktrees", "r1")
        git(sub, "worktree", "add", "-q", "-b", "r1", wt)
        lines = fw.sweep(sub, {}, self.state, "sess-x", True)
        self.assertIn("would remove: %s" % wt, lines)
        self.assertTrue(any(l.startswith("skipped: %s" % r.linked_sub) and "nested_worktree" in l for l in lines), lines)


if __name__ == "__main__":
    unittest.main()
