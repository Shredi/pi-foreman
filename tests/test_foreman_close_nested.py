"""foreman_close cleanup and foreman_worktree sweep with nested submodule worktrees (rig made by an outside tool) and a custom-root layout."""
from __future__ import annotations

import contextlib
import io
import json
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
import foreman_worktree as fw  # noqa: E402
from _submodules import build_rig  # noqa: E402

SID = "sess-nested-1"


class NestedCleanupTest(unittest.TestCase):
    def setUp(self):
        self.base = os.path.realpath(tempfile.mkdtemp(prefix="nested_close_"))
        self.addCleanup(shutil.rmtree, self.base, True)
        p = mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})
        p.start()
        self.addCleanup(p.stop)
        for k in ("PI_FOREMAN_PARENT_INTERCOM", "PI_SUBAGENT_PARENT_SESSION", "CLAUDE_CODE_SESSION_ID", "PI_FOREMAN_STATE_DIR"):
            os.environ.pop(k, None)
        self.state = os.path.join(self.base, "agent", "pi-foreman", "state")
        os.makedirs(self.state)
        self.rig = build_rig(os.path.join(self.base, "rig"))
        # the rig's stray/forged/foreign checkouts and the plain submodule stay in the tree; keep only what a test needs
        for p in (self.rig.forged,):
            shutil.rmtree(p, True)

    def cli(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = fcl.main(list(args) + ["--session", SID, "--state", self.state])
        return code, out.getvalue()

    def rec(self, path):
        fcl.record(self.state, SID, "worktree", path)

    def test_foreign_nested_checkouts_block_and_nothing_is_removed(self):
        r = self.rig
        entries = [{"kind": "worktree", "path": r.tree}]  # outer only: libs/a, b, stray were not created by pi-foreman
        with mock.patch.object(fcl, "check_entry", return_value=(None, {"target": r.tree, "main_dir": r.superproject})):
            res = fcl.cleanup(entries, self.state, SID, {}, True, False)
        self.assertTrue(os.path.isdir(r.tree))
        self.assertTrue(os.path.isdir(r.linked_sub))
        self.assertEqual(res["removed"], [])
        self.assertIn("nested checkouts not created by pi-foreman", json.dumps(res["handovers"]))

    def test_dry_run_reports_group_inner_first(self):
        r = self.rig
        shutil.rmtree(r.foreign, True)
        for inner in (r.stray_inner, ):
            pass
        self.rec(r.tree)
        self.rec(r.linked_sub)
        code, out = self.cli("--cwd", r.superproject, "--dry-run")
        self.assertTrue(os.path.isdir(r.tree))
        self.assertTrue(os.path.isdir(r.linked_sub))
        self.assertNotIn("would remove: %s\n" % r.tree, out)

    def test_nested_inside_lists_linked_and_plain_not_foreign(self):
        r = self.rig
        found = fcl.nested_inside(r.tree)
        self.assertIn(os.path.realpath(r.linked_sub), found)
        self.assertIn(os.path.realpath(r.plain_sub), found)
        self.assertNotIn(os.path.realpath(r.foreign), found)

    def test_manifest_order_is_deepest_first(self):
        r = self.rig
        entries = [{"kind": "worktree", "path": r.tree}, {"kind": "worktree", "path": r.linked_sub}]
        res = fcl.cleanup(entries, self.state, SID, {}, True, True)
        paths = res["wouldRemove"]
        if r.linked_sub in paths and r.tree in paths:
            self.assertLess(paths.index(r.linked_sub), paths.index(r.tree))

    def test_remove_scratch_rmtree_fallback_is_a_note(self):
        d = os.path.join(self.base, "scr")
        os.makedirs(d)
        with mock.patch.object(fcl.shutil, "which", return_value=None):
            note = fcl.remove_scratch(d)
        self.assertIn("rmtree", note)
        self.assertFalse(os.path.exists(d))

    def test_trash_failure_raises_not_silent_rmtree(self):
        d = os.path.join(self.base, "scr2")
        os.makedirs(d)
        fake = mock.Mock(returncode=1, stderr=b"cross-device")
        with mock.patch.object(fcl.shutil, "which", return_value="/bin/trash"), \
                mock.patch.object(fcl.subprocess, "run", return_value=fake):
            with self.assertRaises(OSError):
                fcl.remove_scratch(d)
        self.assertTrue(os.path.isdir(d))


class NestedSweepTest(unittest.TestCase):
    def setUp(self):
        self.base = os.path.realpath(tempfile.mkdtemp(prefix="nested_sweep_"))
        self.addCleanup(shutil.rmtree, self.base, True)
        self.rig = build_rig(self.base)

    def test_main_checkout_of_nested_worktree(self):
        r = self.rig
        self.assertEqual(fw.main_checkout(r.tree), os.path.realpath(r.superproject))

    def test_root_collision_none_for_empty_root(self):
        root = os.path.join(self.base, "emptyroot")
        os.makedirs(root)
        self.assertIsNone(fw.root_collision(self.rig.superproject, root))

    def test_symlinked_root_resolves(self):
        real = os.path.join(self.base, "elsewhere", "trees")
        os.makedirs(real)
        link = os.path.join(self.base, "link")
        os.symlink(real, link)
        res = fw.resolve_worktree_root(self.rig.superproject, os.path.join(link, "<repo>"))
        self.assertIsNone(res.get("error") if isinstance(res, dict) else getattr(res, "error", None))


if __name__ == "__main__":
    unittest.main()
