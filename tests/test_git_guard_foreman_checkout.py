"""A9: git_guard child mode fences the git write subcommands against the foreman's checkout (FOREMAN_CHECKOUT); reads and the child's own
worktree are not fenced. Shapes redacted from the #69 review findings."""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import git_guard as gg  # noqa: E402


@unittest.skipIf(os.name == "nt", "POSIX paths")
class ForemanCheckoutFenceTest(unittest.TestCase):
    def setUp(self):
        self.base = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.base, True)
        self.checkout = os.path.join(self.base, "checkout")
        self.wt = os.path.join(self.base, "wt")
        os.makedirs(os.path.join(self.checkout, ".git"))
        os.makedirs(os.path.join(self.checkout, ".workflow"))
        os.makedirs(self.wt)
        with open(os.path.join(self.wt, ".git"), "w") as f:
            f.write("gitdir: %s\n" % os.path.join(self.checkout, ".git", "worktrees", "wt"))

    def decide(self, cmd, cwd=None, checkout=True):
        env = {"FOREMAN_CHECKOUT": self.checkout} if checkout else {}
        return gg.decide(cmd, "child", cwd=cwd or self.wt, env=env)

    def fenced(self, cmd, **kw):
        d = self.decide(cmd, **kw)
        return d.level == 2 and "child-write-foreman-checkout" in d.reason

    def test_write_verbs_into_the_checkout_are_fenced(self):
        c = self.checkout
        for cmd in ("git -C %s add ." % c, "git -C %s commit -m x" % c, "git -C %s checkout main" % c,
                    "git --git-dir=%s/.git --work-tree=%s add ." % (c, c), "git clone https://example.org/r.git %s/sub" % c,
                    "git -C %s/.workflow add x" % c, "cd %s && git add ." % c, "git -C ../checkout stash"):
            with self.subTest(cmd=cmd):
                self.assertTrue(self.fenced(cmd), self.decide(cmd).reason)

    def test_reads_are_never_fenced(self):
        c = self.checkout
        for cmd in ("git -C %s status" % c, "git -C %s log --oneline" % c, "git -C %s diff" % c, "git -C %s show HEAD" % c):
            with self.subTest(cmd=cmd):
                self.assertFalse(self.fenced(cmd))

    def test_own_worktree_is_not_the_checkout(self):
        self.assertFalse(self.fenced("git add ."))
        self.assertFalse(self.fenced("git -C %s add ." % self.wt))

    def test_own_worktree_nested_in_the_checkout_is_not_fenced(self):
        nested = os.path.join(self.checkout, "nested-wt")
        os.makedirs(nested)
        with open(os.path.join(nested, ".git"), "w") as f:
            f.write("gitdir: x\n")
        self.assertFalse(self.fenced("git add .", cwd=nested))
        self.assertTrue(self.fenced("git -C %s add ." % self.checkout, cwd=nested))

    def test_without_the_binding_there_is_no_fence(self):
        self.assertFalse(self.fenced("git -C %s add ." % self.checkout, checkout=False))

    def test_checkout_through_a_symlink_is_fenced(self):
        link = os.path.join(self.base, "lnk")
        os.symlink(self.checkout, link)
        self.assertTrue(self.fenced("git -C %s add ." % link))

    def test_dynamic_dash_c_word_never_crashes(self):
        scratch = os.path.join(self.base, "pi-foreman-scratch", "s1", "L1")
        os.makedirs(scratch)
        env = {"FOREMAN_CHECKOUT": self.checkout, "FOREMAN_SCRATCH": scratch}
        for cmd in ("git -C $FOREMAN_SCRATCH/r add .", "git -C $FOREMAN_SCRATCH/r commit -m 'fix: x'", "git -C $FOREMAN_SCRATCH/r commit -m x",
                    "git -C $FOREMAN_SCRATCH/r fetch", 'git -C "$PWD" add x'):
            with self.subTest(cmd=cmd):
                d = gg.decide(cmd, "child", cwd=self.wt, env=env)
                self.assertNotIn("child-write-foreman-checkout", d.reason)
                self.assertNotIn("internal error", d.reason)
                if "commit -m x" not in cmd:
                    self.assertEqual(d.level, 0, d.reason)
        d = gg.decide("git -C %s add ." % self.checkout, "child", cwd=self.wt, env=env)
        self.assertTrue(d.level == 2 and "child-write-foreman-checkout" in d.reason)

    def test_scratch_target_inside_the_checkout_is_fenced(self):
        scratch = os.path.join(self.checkout, "pi-foreman-scratch", "s1", "L1")
        os.makedirs(scratch)
        env = {"FOREMAN_CHECKOUT": self.checkout, "FOREMAN_SCRATCH": scratch}
        d = gg.decide("git -C $FOREMAN_SCRATCH/r add .", "child", cwd=self.wt, env=env)
        self.assertTrue(d.level == 2 and "child-write-foreman-checkout" in d.reason, d.reason)


if __name__ == "__main__":
    unittest.main()
