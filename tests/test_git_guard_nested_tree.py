"""Nested submodule checkouts (made by an outside tool): git_guard child mode treats a round's nested checkouts as one tree, bounded by
PI_FOREMAN_TREE_CEILING, and allows `git submodule update|sync|status|foreach` only inside it with unchanged URLs."""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
import git_guard as gg  # noqa: E402
from _submodules import build_rig  # noqa: E402


class _Ctx:
    def __init__(self, ceiling):
        self.env = {"PI_FOREMAN_TREE_CEILING": ceiling} if ceiling else {}


@unittest.skipIf(os.name == "nt", "POSIX paths")
class NestedTreeTest(unittest.TestCase):
    def setUp(self):
        self.base = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.base, True)
        self.rig = build_rig(self.base)

    def test_tree_top_lifts_to_the_ceiling(self):
        r = self.rig
        c = _Ctx(r.tree)
        self.assertEqual(gg.tree_top(r.linked_sub, c), r.tree)
        self.assertEqual(gg.tree_top(r.plain_sub, c), r.tree)

    def test_no_ceiling_no_lift(self):
        r = self.rig
        for cwd in (r.linked_sub, r.plain_sub):
            self.assertEqual(gg.tree_top(cwd, _Ctx("")), os.path.realpath(cwd))

    def test_ceiling_bounds_the_lift(self):
        r = self.rig
        self.assertEqual(gg.tree_top(r.linked_sub, _Ctx(r.linked_sub)), r.linked_sub)

    def test_forged_stray_and_foreign_are_not_lifted(self):
        r = self.rig
        c = _Ctx(r.tree)
        for p in (r.stray_inner, r.foreign):
            self.assertNotEqual(gg.tree_top(p, c), r.tree)
        self.assertEqual(gg.tree_top(r.forged, c), gg.worktree_top(r.forged))

    def decide(self, cmd, cwd, ceiling):
        env = {"PI_FOREMAN_TREE_CEILING": ceiling} if ceiling else {}
        return gg.decide(cmd, "child", cwd=cwd, env=env)

    def test_submodule_verbs_inside_tree(self):
        r = self.rig
        for sub in ("status", "update", "sync", "foreach 'echo x'"):
            d = self.decide("git submodule " + sub, r.tree, r.tree)
            self.assertNotEqual(d.level, 2, (sub, d.reason))

    def test_submodule_refused_outside_tree(self):
        r = self.rig
        self.assertEqual(self.decide("git -C %s submodule status" % r.superproject, r.tree, r.tree).level, 2)

    def test_update_refused_when_gitmodules_url_differs(self):
        r = self.rig
        path = os.path.join(r.tree, ".gitmodules")
        with open(path) as f:
            text = f.read()
        with open(path, "w") as f:
            f.write(text.replace("/src/b", "/elsewhere/b"))
        d = self.decide("git submodule update", r.tree, r.tree)
        self.assertEqual(d.level, 2)
        self.assertIn("differs", d.reason)

    def test_recursive_keeps_refusing(self):
        r = self.rig
        self.assertEqual(self.decide("git submodule update --recursive", r.tree, r.tree).level, 2)

    def test_resolve_relative_url(self):
        self.assertEqual(gg._gm_resolve("../b", "https://h/o/repo.git"), "https://h/o/b")
        self.assertEqual(gg._gm_resolve("./b", "/p/super"), "/p/super/b")
        self.assertEqual(gg._gm_resolve("../../x", "/p/q/super"), "/p/x")


if __name__ == "__main__":
    unittest.main()
