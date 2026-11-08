"""A9: the checkout fence of git_guard names no write target for the read-only forms of git write verbs (branch/tag list, stash list|show,
worktree list, config reads); mutating forms of the same verbs stay fenced."""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import git_guard as gg  # noqa: E402


@unittest.skipIf(os.name == "nt", "POSIX paths")
class ForemanCheckoutReadFormsTest(unittest.TestCase):
    def setUp(self):
        self.base = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.base, True)
        self.checkout = os.path.join(self.base, "checkout")
        self.wt = os.path.join(self.base, "wt")
        os.makedirs(os.path.join(self.checkout, ".git"))
        os.makedirs(self.wt)
        with open(os.path.join(self.wt, ".git"), "w") as f:
            f.write("gitdir: x\n")

    def fenced(self, cmd):
        d = gg.decide(cmd, "child", cwd=self.wt, env={"FOREMAN_CHECKOUT": self.checkout})
        return d.level == 2 and "child-write-foreman-checkout" in d.reason

    def test_read_forms_pass(self):
        c = self.checkout
        for v in ("branch", "branch -vv", "stash list", "stash show", "worktree list", "worktree list --porcelain", "worktree list -v -z",
                  "config --get user.name", "config --list", "config user.name", "config --get-regexp ^user", "config --show-origin --list",
                  "tag", "tag -l", "tag -l 'v*'", "tag -n5", "tag --contains HEAD", "tag --sort=-creatordate", "tag --points-at HEAD"):
            with self.subTest(v=v):
                self.assertFalse(self.fenced("git -C %s %s" % (c, v)))
                self.assertFalse(self.fenced("cd %s && git %s" % (c, v)))

    def test_mutating_forms_stay_fenced(self):
        c = self.checkout
        for v in ("worktree add x", "worktree remove x", "worktree prune", "worktree list --bogus", "config user.name x", "config --unset x",
                  "config --add a b", "config --edit", "tag v1", "tag -d v1", "tag -a v1 -m x", "tag -f v1", "branch -D x",
                  "stash push", "stash pop", "stash show --output=%s/x" % c, "commit -m x", "fetch"):
            with self.subTest(v=v):
                self.assertTrue(self.fenced("git -C %s %s" % (c, v)))


if __name__ == "__main__":
    unittest.main()
