"""The child's own-scratch exception compares realpaths on both sides: a scratch root through a symlinked tmp dir (macOS /var -> /private/var)
and a literal target through the real path, and the reverse, are the own scratch; a sibling dir is not."""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import git_guard as gg  # noqa: E402


@unittest.skipIf(os.name == "nt", "POSIX symlinks")
class ScratchRealpathTest(unittest.TestCase):
    def setUp(self):
        self.base = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.base, True)
        self.real = os.path.join(self.base, "real")
        self.link = os.path.join(self.base, "lnk")
        os.makedirs(os.path.join(self.real, "pi-foreman-scratch", "s1", "L1"))
        os.makedirs(os.path.join(self.real, "other"))
        os.symlink(self.real, self.link)

    def level(self, scratch, cmd):
        return gg.decide(cmd, "child", cwd=self.base, env={"FOREMAN_SCRATCH": scratch}).level

    def heredoc(self, d):
        return "cat > %s/m.txt <<EOF\nhi\nEOF" % d

    def test_root_through_symlink_literal_real_target(self):
        root = os.path.join(self.link, "pi-foreman-scratch", "s1", "L1")
        self.assertEqual(self.level(root, self.heredoc(os.path.join(self.real, "pi-foreman-scratch", "s1", "L1"))), 0)

    def test_root_real_literal_symlink_target(self):
        root = os.path.join(self.real, "pi-foreman-scratch", "s1", "L1")
        self.assertEqual(self.level(root, self.heredoc(os.path.join(self.link, "pi-foreman-scratch", "s1", "L1"))), 0)

    def test_sibling_dir_stays_outside(self):
        root = os.path.join(self.link, "pi-foreman-scratch", "s1", "L1")
        self.assertEqual(self.level(root, self.heredoc(os.path.join(self.real, "other"))), 2)
        self.assertEqual(self.level(root, self.heredoc(os.path.join(self.link, "other"))), 2)

    def test_git_clone_targets(self):
        for root, lit in ((os.path.join(self.link, "pi-foreman-scratch", "s1", "L1"), os.path.join(self.real, "pi-foreman-scratch", "s1", "L1")),
                          (os.path.join(self.real, "pi-foreman-scratch", "s1", "L1"), os.path.join(self.link, "pi-foreman-scratch", "s1", "L1"))):
            u = "git clone https://example.invalid/r.git "
            for cmd in (u + "$FOREMAN_SCRATCH/r", u + '"$FOREMAN_SCRATCH/r"', "S=$FOREMAN_SCRATCH/w; " + u + "$S/r", u + lit + "/r"):
                with self.subTest(root=root, cmd=cmd):
                    self.assertEqual(self.level(root, cmd), 0)

    def test_git_clone_targets_with_a_foreman_checkout_set(self):
        co = os.path.join(self.base, "checkout")
        os.makedirs(os.path.join(co, ".git"))
        root = os.path.join(self.link, "pi-foreman-scratch", "s1", "L1")
        u = "git clone https://example.invalid/r.git "
        for cmd in (u + "$FOREMAN_SCRATCH/r", u + '"$FOREMAN_SCRATCH/r"', "S=$FOREMAN_SCRATCH/w; " + u + "$S/r"):
            with self.subTest(cmd=cmd):
                d = gg.decide(cmd, "child", cwd=self.base, env={"FOREMAN_SCRATCH": root, "FOREMAN_CHECKOUT": co})
                self.assertEqual(d.level, 0, d.reason)


if __name__ == "__main__":
    unittest.main()
