"""D120: a closed local child's kept hc terminal ends and is removed; its worktree goes after it (never for a prune-closed child)."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))
from test_foreman_session_restart import LocalRestartBase, CHILD  # noqa: E402
import foreman_session as fsn  # noqa: E402


class ReapTest(LocalRestartBase):
    def setUp(self):
        super().setUp()
        self.write_entry(status="closed")

    def reap(self, worktree=None, **env):
        """One `list` pass (stdout of the pass is dropped); `worktree` replaces the worktree removal (None: nothing to remove)."""
        with mock.patch.object(fsn, "remove_closed_worktree", return_value=worktree) as wt:
            code, out, err = self.run_main("list", **env)
        self.assertEqual(code, 0, err)
        return wt

    def test_finished_terminal_is_removed_on_close(self):
        self.reap()
        self.assertNotIn("t1", self.terminals())
        self.assertTrue(self.stored()["reaped"])

    def test_live_terminal_is_killed_only_after_the_grace_period(self):
        self.set_terminals({"t1": {"address": "t1", "name": fsn.hc_name(CHILD), "state": "live", "labels": {}}})
        self.reap()
        self.assertEqual(self.hc_calls("kill"), [])
        self.assertIn("t1", self.terminals())
        self.write_entry(reapSeenAt=time.time() - fsn.LOCAL_REAP_GRACE - 5)
        self.reap()
        self.assertEqual([c[1] for c in self.hc_calls("kill")], ["t1"])
        self.assertNotIn("t1", self.terminals())
        self.assertTrue(self.stored()["reaped"])

    def test_terminal_with_another_name_is_left_alone(self):
        self.set_terminals({"t1": {"address": "t1", "name": "someone-else", "state": "finished", "labels": {}}})
        self.reap()
        self.assertIn("t1", self.terminals())
        self.assertEqual((self.hc_calls("kill"), self.hc_calls("rm")), ([], []))
        stored = self.stored()
        self.assertTrue(stored["reaped"])
        self.assertIn("another name", stored["note"])

    def test_a_failed_terminal_read_is_retried_by_a_later_pass(self):
        with mock.patch.object(fsn, "hc_terminal_info", return_value={"state": "unknown", "foreground": None, "notice": None}):
            self.reap()
        self.assertFalse(self.stored().get("reaped"))
        self.write_entry(reapRetryAt=time.time() - fsn.REAP_RETRY_PAUSE - 1)
        self.reap()
        self.assertTrue(self.stored()["reaped"])
        self.assertNotIn("t1", self.terminals())

    def test_a_failed_pass_waits_before_the_next_try(self):
        self.write_entry(reapRetryAt=time.time())
        self.reap()
        self.assertIn("t1", self.terminals())

    def test_prune_closed_entry_keeps_its_worktree_and_branch(self):
        self.write_entry(closedBy="prune", note=fsn.PRUNE_NOTE)
        wt = self.reap()
        wt.assert_not_called()
        self.assertNotIn("t1", self.terminals())
        self.assertTrue(self.stored()["reaped"])

    def test_close_flow_entry_retries_the_worktree_after_the_reap(self):
        self.write_entry(worktreePending=True)  # the mark the close flow sets (changed on purpose: an unmarked entry keeps its worktree)
        wt = self.reap(worktree="a running session uses the folder")
        wt.assert_called_once()
        stored = self.stored()
        self.assertTrue(stored["reaped"])
        self.assertFalse(stored.get("worktreeDone"))
        self.assertIn("worktree kept", stored["lastError"])
        self.write_entry(reapRetryAt=time.time() - fsn.REAP_RETRY_PAUSE - 1)
        wt = self.reap()
        wt.assert_called_once()
        self.assertTrue(self.stored()["worktreeDone"])
        self.assertEqual(self.hc_calls("rm"), [["rm", "t1"]])  # the terminal is not reaped twice


class WorktreeRemovalTest(unittest.TestCase):
    """The real safe removal: clean apart from an untracked .workflow/ goes with its branch; anything else stays."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="reap_wt_")).resolve()
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.adir = self.tmp / "agent"
        self.adir.mkdir()
        (self.adir / "foreman.json").write_text(json.dumps({"close": {"worktreeDir": str(self.tmp / "wts" / "<repo>")}}), "utf-8")
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        self.git(self.repo, "init", "-q", "-b", "main")
        (self.repo / "a.txt").write_text("a\n", "utf-8")
        self.git(self.repo, "add", "a.txt")
        self.git(self.repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init")
        self.wt = self.tmp / "wts" / "repo" / "child"
        self.git(self.repo, "worktree", "add", "-q", "-b", "child", str(self.wt))
        self.entry = {"cwd": str(self.wt), "child": CHILD}

    def git(self, cwd, *args):
        return subprocess.run(["git", "-C", str(cwd)] + list(args), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=True).stdout.decode()

    def branches(self):
        return self.git(self.repo, "branch", "--list", "child").strip()

    def test_untracked_workflow_folder_counts_as_clean(self):
        (self.wt / ".workflow").mkdir()
        (self.wt / ".workflow" / "notes.md").write_text("x\n", "utf-8")
        self.assertIsNone(fsn.remove_closed_worktree(self.adir, self.entry, []))
        self.assertFalse(self.wt.exists())
        self.assertEqual(self.branches(), "")

    def test_other_untracked_work_keeps_the_worktree(self):
        (self.wt / "new.txt").write_text("x\n", "utf-8")
        self.assertIsNotNone(fsn.remove_closed_worktree(self.adir, self.entry, []))
        self.assertTrue(self.wt.exists())
        self.assertNotEqual(self.branches(), "")

    def test_a_running_session_in_the_folder_keeps_the_worktree(self):
        live = [{"cwd": str(self.wt), "pid": os.getpid()}]
        self.assertEqual(fsn.remove_closed_worktree(self.adir, self.entry, live), "a running session uses the folder")
        self.assertTrue(self.wt.exists())

if __name__ == "__main__":
    unittest.main()
