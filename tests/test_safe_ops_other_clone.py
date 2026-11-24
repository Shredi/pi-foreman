"""safe_ops.check_worktree for a linked worktree of another clone (D165): the worktree's own repository is listed, not the session's (temp repos only)."""
from __future__ import annotations

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
import safe_ops  # noqa: E402


def g(cwd, *args):
    subprocess.run(["git", "-c", "user.name=T", "-c", "user.email=t@example.invalid"] + list(args), cwd=str(cwd),
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)


def clone(root, name):
    repo = root / name
    repo.mkdir()
    g(repo, "init", "-q", "-b", "main")
    (repo / "README").write_text("x\n")
    g(repo, "add", ".")
    g(repo, "commit", "-q", "-m", "init")
    return repo


class OtherCloneTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="other_clone_test_")))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        patch = mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})
        patch.start()
        self.addCleanup(patch.stop)
        self.a = clone(self.tmp, "clone-a")
        self.b = clone(self.tmp, "clone-b")
        self.wtb = self.tmp / "wt-b"
        g(self.b, "worktree", "add", "-q", "-b", "feat", str(self.wtb))
        for repo in (self.a, self.b):
            g(repo, "remote", "add", "origin", "https://example.invalid/project.git")
        self.cfg = safe_ops.ops_config({})

    def test_a_linked_worktree_of_clone_b_is_removed_from_a_session_in_clone_a(self):
        chk = safe_ops.check_worktree(str(self.a), str(self.wtb), self.cfg)
        self.assertEqual((chk["branch"], chk["main_dir"]), ("feat", str(self.b)))
        safe_ops.remove_worktree(chk)
        self.assertFalse(self.wtb.exists())

    def test_the_main_worktree_of_clone_b_is_still_refused(self):
        with self.assertRaises(safe_ops.Precondition) as cm:
            safe_ops.check_worktree(str(self.a), str(self.b), self.cfg)
        self.assertEqual(cm.exception.name, "main_worktree")

    def test_a_path_that_is_no_linked_worktree_is_still_refused(self):
        plain = self.tmp / "plain"
        plain.mkdir()
        sub = self.b / "sub"
        sub.mkdir()
        for p in (plain, sub, self.tmp / "missing"):
            with self.assertRaises(safe_ops.Precondition) as cm:
                safe_ops.check_worktree(str(self.a), str(p), self.cfg)
            self.assertEqual(cm.exception.name, "not_linked_worktree", p)

    def test_an_unrelated_repository_keeps_its_refusal(self):
        g(self.b, "remote", "set-url", "origin", "https://example.invalid/other.git")
        with self.assertRaises(safe_ops.Precondition) as cm:
            safe_ops.check_worktree(str(self.a), str(self.wtb), self.cfg)
        self.assertEqual(cm.exception.name, "not_linked_worktree")


if __name__ == "__main__":
    unittest.main()
