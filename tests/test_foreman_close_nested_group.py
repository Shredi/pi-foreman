"""foreman_close cleanup of a fully manifest-recorded nested tree: inner first, empty dir recreated; a dirty inner checkout blocks the whole group."""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, "..", "scripts")
sys.path.insert(0, HERE)
sys.path.insert(0, SCRIPTS)
import _isolation  # noqa: E402,F401
import foreman_close as fcl  # noqa: E402
import safe_ops  # noqa: E402
from _submodules import build_rig, git  # noqa: E402

SID = "sess-nested-group"


@unittest.skipIf(os.name == "nt", "POSIX paths and symlinks")
class NestedGroupTest(unittest.TestCase):
    def setUp(self):
        self.base = os.path.realpath(tempfile.mkdtemp(prefix="nested_group_"))
        self.addCleanup(shutil.rmtree, self.base, True)
        p = mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})
        p.start()
        self.addCleanup(p.stop)
        self.state = os.path.join(self.base, "agent", "pi-foreman", "state")
        os.makedirs(self.state)
        r = self.rig = build_rig(os.path.join(self.base, "rig"))
        # keep only the linked submodule worktree in the round tree: the plain checkout, the stray clone, the forged and the foreign dirs go
        admin_tree = git(r.tree, "rev-parse", "--absolute-git-dir")
        for p in (r.foreign, r.forged, os.path.join(r.tree, "stray"), r.plain_sub, os.path.join(admin_tree, "modules")):
            shutil.rmtree(p, True)
        os.makedirs(r.plain_sub, exist_ok=True)  # git leaves a gitlink path as an empty dir
        self.cfg = safe_ops.ops_config({})
        self.entries = [{"kind": "worktree", "path": r.tree}, {"kind": "worktree", "path": r.linked_sub}]

    def run_cleanup(self, dry=False):
        return fcl.cleanup(self.entries, self.state, SID, self.cfg, True, dry)

    def test_recorded_nested_tree_is_removed_inner_first_and_dir_recreated(self):
        r = self.rig
        order = []
        real = safe_ops.remove_worktree

        def spy(chk):
            order.append(os.path.realpath(chk["target"]))
            return real(chk)

        with mock.patch.object(safe_ops, "remove_worktree", side_effect=spy):
            res = self.run_cleanup()
        self.assertEqual(res["handovers"], [], res)
        self.assertEqual(order, [os.path.realpath(r.linked_sub), os.path.realpath(r.tree)])
        self.assertEqual(sorted(res["removed"]), sorted([r.tree, r.linked_sub]))
        self.assertFalse(os.path.exists(r.tree))

    def test_inner_dir_is_recreated_while_the_outer_stays(self):
        r = self.rig
        res = fcl.cleanup([self.entries[1]], self.state, SID, self.cfg, True, False)
        self.assertEqual(res["handovers"], [], res)
        self.assertEqual(res["removed"], [r.linked_sub])
        self.assertTrue(os.path.isdir(r.linked_sub))
        self.assertFalse(os.path.exists(os.path.join(r.linked_sub, ".git")))
        self.assertEqual(os.listdir(r.linked_sub), [])

    def test_dirty_inner_checkout_blocks_the_whole_group(self):
        r = self.rig
        with open(os.path.join(r.linked_sub, "dirty.txt"), "w") as fh:
            fh.write("x\n")
        res = self.run_cleanup()
        self.assertEqual(res["removed"], [])
        self.assertEqual(len(res["handovers"]), 2, res)
        self.assertTrue(os.path.isdir(r.tree))
        self.assertTrue(os.path.isfile(os.path.join(r.linked_sub, "dirty.txt")))
        self.assertTrue(os.path.isfile(os.path.join(r.linked_sub, ".git")))


if __name__ == "__main__":
    unittest.main()
