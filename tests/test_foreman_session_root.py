"""`foreman session open --worktree` with a custom absolute worktree root (separate temp tree, and a symlinked variant), the reserved
label `worktrees`, a refused setting and a root already holding another repo's worktree. Nothing reaches the network."""
from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_foreman_session_worktree as base  # noqa: E402
from test_foreman_session_worktree import git  # noqa: E402


@unittest.skipIf(os.name == "nt", "POSIX paths and symlinks")
class CustomRootOpenTest(base.WorktreeOpenTest):
    def setUp(self):
        super().setUp()
        self.trees = self.tmp / "elsewhere" / "trees"
        self.trees.mkdir(parents=True)

    def configure(self, template):
        self.agent.mkdir(parents=True, exist_ok=True)
        (self.agent / "foreman.json").write_text(json.dumps({"close": {"worktreeDir": template}}), "utf-8")

    def open_wt(self, label="demo"):
        with mock.patch.object(base.fsn, "run_npm_ci", return_value=0):
            return self.run_main("--worktree", label=label)

    def test_custom_absolute_root_is_used(self):
        self.configure(str(self.trees / "<repo>"))
        code, out, err = self.open_wt()
        self.assertEqual(code, 0, err)
        self.assertTrue((self.trees / "work" / "demo" / ".git").exists())
        self.assertFalse(self.target.exists())

    def test_symlinked_root_is_used(self):
        link = self.tmp / "link-to-trees"
        os.symlink(str(self.trees), str(link))
        self.configure(str(link / "<repo>"))
        code, out, err = self.open_wt()
        self.assertEqual(code, 0, err)
        self.assertTrue((self.trees / "work" / "demo" / ".git").exists())

    def test_label_worktrees_is_refused(self):
        code, out, err = self.open_wt("worktrees")
        self.assertEqual(code, 1)
        self.assertIn("worktrees", err)
        self.assertFalse((self.tmp / "work.worktrees" / "worktrees").exists())

    def test_refused_setting_creates_nothing(self):
        self.configure("~")
        code, out, err = self.open_wt()
        self.assertEqual(code, 1)
        self.assertFalse(self.target.exists())

    def test_root_holding_another_repos_worktree_is_refused(self):
        other = self.tmp / "other"
        git(self.tmp, "clone", "-q", str(self.origin), str(other))
        self.configure(str(self.trees / "shared"))
        (self.trees / "shared").mkdir()
        git(other, "worktree", "add", "-q", "-b", "o1", str(self.trees / "shared" / "o1"))
        code, out, err = self.open_wt()
        self.assertEqual(code, 1)
        self.assertFalse((self.trees / "shared" / "demo").exists())


# the inherited default-layout tests run in base; only the custom-root cases belong here
for _n in [n for n in dir(CustomRootOpenTest) if n.startswith("test_") and n not in vars(CustomRootOpenTest)]:
    setattr(CustomRootOpenTest, _n, None)

if __name__ == "__main__":
    unittest.main()
