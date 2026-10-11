"""scripts/foreman_worktree_setup.py: symlinked node_modules becomes a real directory."""
from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_worktree_setup as hook  # noqa: E402


@unittest.skipIf(os.name == "nt", "symlink fixtures are POSIX only")
class WorktreeSetupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="wtsetup_test_")))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.main = self.tmp / "main"
        (self.main / "node_modules" / "pkg").mkdir(parents=True)
        (self.main / "node_modules" / "pkg" / "index.js").write_text("x\n")
        (self.main / "node_modules" / "alias").symlink_to("pkg")
        self.wt = self.tmp / "wt"
        self.wt.mkdir()
        (self.wt / "node_modules").symlink_to(self.main / "node_modules")

    def run_hook(self, argv=()):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = hook.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_symlink_with_lockfile_becomes_real_copy(self):
        (self.wt / "package-lock.json").write_text("{}\n")
        code, out, err = self.run_hook([str(self.wt)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {})
        nm = self.wt / "node_modules"
        self.assertFalse(nm.is_symlink())
        self.assertTrue(nm.is_dir())
        self.assertEqual(sorted(p.name for p in nm.iterdir()), ["alias", "pkg"])
        self.assertTrue((nm / "alias").is_symlink())
        self.assertNotEqual(os.stat(nm / "pkg" / "index.js").st_ino, os.stat(self.main / "node_modules" / "pkg" / "index.js").st_ino)
        self.assertEqual(len(err.strip().splitlines()), 1)
        (nm / "pkg" / "index.js").write_text("changed\n")
        self.assertEqual((self.main / "node_modules" / "pkg" / "index.js").read_text(), "x\n")

    def test_failed_copy_keeps_the_link_and_leaves_no_partial_directory(self):
        (self.wt / "package-lock.json").write_text("{}\n")
        real = shutil.copytree

        def boom(src, dst, *a, **kw):
            os.makedirs(dst)
            (Path(dst) / "half").write_text("x")
            raise OSError("disk full")

        shutil.copytree = boom
        try:
            code, out, err = self.run_hook([str(self.wt)])
        finally:
            shutil.copytree = real
        self.assertEqual(code, 0)
        self.assertIn("failed", err)
        self.assertTrue((self.wt / "node_modules").is_symlink())
        self.assertEqual(sorted(p.name for p in self.wt.iterdir()), ["node_modules", "package-lock.json"])

    def test_shrinkwrap_counts_as_lockfile(self):
        (self.wt / "npm-shrinkwrap.json").write_text("{}\n")
        self.run_hook([str(self.wt)])
        self.assertFalse((self.wt / "node_modules").is_symlink())

    def test_without_lockfile_link_is_kept(self):
        code, out, _ = self.run_hook([str(self.wt)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {})
        self.assertTrue((self.wt / "node_modules").is_symlink())

    def test_missing_target_exits_zero(self):
        (self.wt / "package-lock.json").write_text("{}\n")
        shutil.rmtree(str(self.main / "node_modules"))
        old_path = os.environ.get("PATH")
        os.environ["PATH"] = os.devnull
        try:
            code, out, err = self.run_hook([str(self.wt)])
        finally:
            os.environ["PATH"] = old_path
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {})
        self.assertEqual(len(err.strip().splitlines()), 1)

    def test_missing_worktree_exits_zero(self):
        code, out, _ = self.run_hook([str(self.tmp / "nope")])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {})


if __name__ == "__main__":
    unittest.main()
