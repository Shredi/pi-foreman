"""create_worktree never runs `npm ci` through a node_modules link: it would empty the link target."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _isolation  # noqa: E402,F401
import foreman_session as fsn  # noqa: E402


class LinkedNodeModulesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = os.path.realpath(self.tmp.name)
        self.wt = os.path.join(self.base, "wt")
        self.outside = os.path.join(self.base, "outside_nm")
        os.makedirs(self.wt)
        os.makedirs(self.outside)
        Path(self.outside, "sentinel").write_text("x")
        Path(self.wt, "package-lock.json").write_text("{}")

    def create(self):
        plan = {"repo": self.base, "path": self.wt, "branch": "b", "base": "main"}
        with mock.patch.object(fsn, "git_out", return_value=(0, "")), mock.patch.object(fsn, "run_npm_ci", return_value=0) as npm:
            info = fsn.create_worktree(plan)
        return info, npm

    def test_linked_node_modules_skips_npm_ci(self):
        os.symlink(self.outside, os.path.join(self.wt, "node_modules"), target_is_directory=True)
        info, npm = self.create()
        npm.assert_not_called()
        self.assertEqual(info["install"], "skipped (node_modules is a link to %s)" % self.outside)
        self.assertTrue(os.path.exists(os.path.join(self.outside, "sentinel")))

    def test_real_node_modules_still_installs(self):
        os.makedirs(os.path.join(self.wt, "node_modules"))
        info, npm = self.create()
        npm.assert_called_once()
        self.assertEqual(info["install"], "npm ci")

    def test_helper_none_without_node_modules(self):
        self.assertIsNone(fsn.linked_node_modules(self.wt))


if __name__ == "__main__":
    unittest.main()
