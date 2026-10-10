"""scripts/foreman_worktree.py sweep against a temp repo."""
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
    subprocess.run(["git", "-c", "user.name=T", "-c", "user.email=t@example.invalid"] + list(args), cwd=str(cwd),
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)


class SweepTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="sweep_test_")))
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
        self.conv = self.tmp / "repo.worktrees" / "clean"
        self.off = self.tmp / "elsewhere"
        self.dirty = self.tmp / "repo.worktrees" / "dirty"
        for p, b in ((self.conv, "clean"), (self.off, "off"), (self.dirty, "dirty")):
            g(self.repo, "worktree", "add", "-q", "-b", b, str(p))
        (self.dirty / "x").write_text("d\n")

    def sweep(self, *extra):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = fw.main(["sweep", "--cwd", str(self.repo), "--state", str(self.state), "--session", "s"] + list(extra))
        return code, out.getvalue().splitlines()

    def test_dry_run_lists_and_removes_nothing(self):
        code, lines = self.sweep("--dry-run")
        self.assertEqual(code, 0)
        self.assertIn("would remove: %s" % self.conv, lines)
        self.assertIn("would remove: %s" % self.off, lines)
        self.assertIn("skipped: %s — worktree_dirty" % self.dirty, lines)
        self.assertEqual([ln for ln in lines if ln.startswith("off-convention:")], ["off-convention: %s" % self.off])
        self.assertTrue(self.conv.is_dir() and self.off.is_dir())

    def test_sweep_removes_merged_clean(self):
        code, lines = self.sweep()
        self.assertIn("removed: %s" % self.conv, lines)
        self.assertFalse(self.conv.exists() or self.off.exists())
        self.assertTrue(self.dirty.is_dir())

    def test_sweep_skips_the_worktree_holding_the_callers_cwd(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = fw.main(["sweep", "--cwd", str(self.conv), "--state", str(self.state), "--session", "s"])
        lines = out.getvalue().splitlines()
        self.assertEqual(code, 0)
        self.assertIn("skipped: %s — in_use_by_caller" % self.conv, lines)
        self.assertIn("removed: %s" % self.off, lines)
        self.assertTrue(self.conv.is_dir())


if __name__ == "__main__":
    unittest.main()
