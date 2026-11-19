"""A symlink or junction named like a dir-only worktreeDisposable entry (`node_modules` as a link) is disposable: only the
link is removed, never its target (temp repos only)."""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_safe_ops_ignored_files import g, put, safe_ops  # noqa: E402


class DisposableLinkTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="disp_link_test_")))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        patch = mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})
        patch.start()
        self.addCleanup(patch.stop)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        g(self.repo, "init", "-q", "-b", "main")
        put(self.repo, "README")
        g(self.repo, "add", ".")
        g(self.repo, "commit", "-q", "-m", "init")
        self.wt = self.tmp / "wt"
        g(self.repo, "worktree", "add", "-q", "-b", "feat", str(self.wt))
        self.cfg = safe_ops.ops_config({})
        self.target = self.tmp / "outside"
        self.keep = put(self.target, "keep.txt")

    def link(self, rel):
        p = self.wt / Path(*rel.split("/"))
        p.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.symlink(str(self.target), str(p), target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")

    def check(self):
        return safe_ops.check_worktree(str(self.wt), str(self.wt), self.cfg, verified_merged=True)

    def assert_removed(self):
        safe_ops.remove_worktree(self.check())
        self.assertFalse(self.wt.exists())
        self.assertTrue(self.keep.exists())

    def refused(self, name="worktree_dirty"):
        with self.assertRaises(safe_ops.Precondition) as cm:
            self.check()
        self.assertEqual(cm.exception.name, name)
        self.assertTrue(self.wt.exists())
        self.assertTrue(self.keep.exists())

    def test_untracked_link_is_removed_and_target_kept(self):
        self.link("node_modules")
        self.assertIn("node_modules", self.check()["untracked"])
        self.assert_removed()

    def test_untracked_nested_link_is_removed(self):
        put(self.wt, "pkg/a.txt")
        g(self.wt, "add", "pkg/a.txt")
        g(self.wt, "commit", "-q", "-m", "pkg")
        self.link("pkg/node_modules")
        self.assert_removed()

    def test_ignored_link_is_removed_and_target_kept(self):
        put(self.wt, ".gitignore", "node_modules\n")
        g(self.wt, "add", ".gitignore")
        g(self.wt, "commit", "-q", "-m", "ignore")
        self.link("node_modules")
        self.assert_removed()

    def test_ignored_nested_link_is_removed(self):
        put(self.wt, ".gitignore", "node_modules\n")
        g(self.wt, "add", ".gitignore")
        g(self.wt, "commit", "-q", "-m", "ignore")
        self.link("pkg/node_modules")
        self.assert_removed()

    def test_dir_only_ignore_pattern_leaves_an_untracked_link_still_removed(self):
        put(self.wt, ".gitignore", "/node_modules/\n")
        g(self.wt, "add", ".gitignore")
        g(self.wt, "commit", "-q", "-m", "ignore")
        self.link("node_modules")  # git does not match a link with a dir-only pattern: it reports `?? node_modules`
        self.assert_removed()

    def test_link_with_another_name_is_refused(self):
        self.link("other")
        self.refused()

    def test_ignored_link_with_another_name_is_refused(self):
        put(self.wt, ".gitignore", "other\n")
        g(self.wt, "add", ".gitignore")
        g(self.wt, "commit", "-q", "-m", "ignore")
        self.link("other")
        self.refused("ignored_files")

    def test_regular_file_named_like_the_folder_is_refused(self):
        put(self.wt, "node_modules")
        self.refused()

    @unittest.skipUnless(os.name == "nt", "junctions exist on Windows only")
    def test_junction_is_removed_and_target_kept(self):
        import subprocess
        subprocess.run(["cmd", "/c", "mklink", "/J", str(self.wt / "node_modules"), str(self.target)],
                       check=True, stdout=subprocess.PIPE)
        self.assert_removed()


if __name__ == "__main__":
    unittest.main()
