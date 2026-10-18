"""R12 item 10: copy accepts a source under one of the request's top-level srcRoots (the foreman's own handoff dirs),
realpath'd, without symlinks; the destination stays inside the workspace. srcRoots inside args, or on another op, is ignored.
All files live in temp dirs SafeOpsCase creates and removes."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_safe_ops import NO_SYMLINK, SYMLINKS, SafeOpsCase  # noqa: E402
import safe_ops  # noqa: E402


class HandoffSrcCopyTest(SafeOpsCase):
    def setUp(self):
        super().setUp()
        self.own = os.path.join(self.tmp, "handoffs", "own")
        self.foreign = os.path.join(self.tmp, "handoffs", "foreign")
        self.write("plan.md", "own plan\n", base=self.own)
        self.write("plan.md", "foreign plan\n", base=self.foreign)
        os.makedirs(os.path.join(self.repo, "scratch"))

    def copy(self, roots, src, dst, op="copy", in_args=False):
        args = {"src": src, "dst": dst}
        req = {"op": op, "args": args, "cwd": self.repo, "config": {}}
        if in_args:
            args["srcRoots"] = roots
        else:
            req["srcRoots"] = roots
        return safe_ops.handle(req)

    def test_copy_from_own_handoff_dir_allowed(self):
        res = self.copy([self.own], os.path.join(self.own, "plan.md"), "scratch/plan.md")
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["action"], "copy_file", res)
        self.assertEqual(Path(self.repo, "scratch", "plan.md").read_text("utf-8"), "own plan\n")
        # a directory copy too
        self.write("sub/r.md", "r\n", base=self.own)
        res = self.copy([self.own], os.path.join(self.own, "sub"), "scratch/sub")
        self.assertTrue(res["ok"], res)
        self.assertTrue(os.path.isfile(os.path.join(self.repo, "scratch", "sub", "r.md")))

    @unittest.skipUnless(SYMLINKS, NO_SYMLINK)
    def test_copy_from_own_handoff_dir_root_realpathd(self):
        # the root reaches the dir through a symlink (macOS /var vs /private/var): realpath'd on both sides
        alias = os.path.join(self.tmp, "alias")
        os.symlink(os.path.join(self.tmp, "handoffs"), alias, target_is_directory=True)
        res = self.copy([os.path.join(alias, "own")], os.path.join(self.own, "plan.md"), "scratch/a.md")
        self.assertTrue(res["ok"], res)
        res = self.copy([self.own], os.path.join(alias, "own", "plan.md"), "scratch/b.md")
        self.assertTrue(res["ok"], res)

    def test_copy_from_foreign_handoff_dir_refused(self):
        self.failed(self.copy([self.own], os.path.join(self.foreign, "plan.md"), "scratch/plan.md"), "outside_workspace")
        self.failed(self.copy([self.own], os.path.join(self.own, "..", "foreign", "plan.md"), "scratch/plan.md"),
                    "outside_workspace")
        # no roots, roots inside args, or another op: the old workspace-only rule
        self.failed(self.copy([], os.path.join(self.own, "plan.md"), "scratch/plan.md"), "outside_workspace")
        self.failed(self.copy([self.own], os.path.join(self.own, "plan.md"), "scratch/plan.md", in_args=True), "outside_workspace")
        self.failed(self.copy([self.own], os.path.join(self.own, "plan.md"), "scratch/plan.md", op="move"), "outside_workspace")
        self.assertTrue(os.path.isfile(os.path.join(self.own, "plan.md")))
        # the root itself is not a source; a malformed srcRoots is a bad request
        self.failed(self.copy([self.own], self.own, "scratch/own"), "outside_workspace")
        self.failed(self.copy(["relative/dir"], os.path.join(self.own, "plan.md"), "scratch/plan.md"), "bad_request")
        self.failed(self.copy(self.own, os.path.join(self.own, "plan.md"), "scratch/plan.md"), "bad_request")
        self.assertFalse(os.path.exists(os.path.join(self.repo, "scratch", "plan.md")))

    @unittest.skipUnless(SYMLINKS, NO_SYMLINK)
    def test_copy_handoff_src_symlink_refused(self):
        secret = self.write("secret.txt", "s\n", base=tempfile.mkdtemp(dir=self.tmp))
        os.symlink(secret, os.path.join(self.own, "link.md"))
        self.failed(self.copy([self.own], os.path.join(self.own, "link.md"), "scratch/x.md"), "outside_workspace")
        os.symlink(os.path.join(self.own, "plan.md"), os.path.join(self.own, "inner.md"))
        self.failed(self.copy([self.own], os.path.join(self.own, "inner.md"), "scratch/y.md"), "src_symlink")
        os.makedirs(os.path.join(self.own, "d"))
        os.symlink(secret, os.path.join(self.own, "d", "l.md"))
        self.failed(self.copy([self.own], os.path.join(self.own, "d"), "scratch/d"), "src_symlink")
        self.assertEqual(sorted(os.listdir(os.path.join(self.repo, "scratch"))), [])

    def test_copy_handoff_src_dst_outside_workspace_refused(self):
        src = os.path.join(self.own, "plan.md")
        self.failed(self.copy([self.own], src, os.path.join(self.own, "copy.md")), "outside_workspace")
        self.failed(self.copy([self.own], src, "../out.md"), "outside_workspace")
        self.failed(self.copy([self.own], src, ".git/x.md"), "inside_git_dir")
        self.assertFalse(os.path.exists(os.path.join(self.own, "copy.md")))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "out.md")))


if __name__ == "__main__":
    unittest.main()
