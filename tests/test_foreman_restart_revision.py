"""Revision of the restart round: the worktree reap never takes a folder another entry uses, only a marked entry is retried,
a stale lock is taken once, a reap mark never lands on a reopened entry, a restart of a just-started Pi is refused."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from test_foreman_session_restart import LocalRestartBase, CHILD  # noqa: E402
import foreman_session as fsn  # noqa: E402


class SharedWorktreeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="rev_wt_")).resolve()
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
        self.entry = {"cwd": str(self.wt), "child": CHILD, "status": "closed"}

    def git(self, cwd, *args):
        return subprocess.run(["git", "-C", str(cwd)] + list(args), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=True).stdout.decode()

    def registry(self, *others):
        fsn.write_registry(self.adir, {"sessions": [self.entry] + [dict({"cwd": str(self.wt)}, **o) for o in others]})

    def test_open_entry_on_the_same_worktree_keeps_it(self):
        self.registry({"child": "other-open", "status": "open"})
        self.assertIsNotNone(fsn.remove_closed_worktree(self.adir, self.entry, []))
        self.assertTrue(self.wt.exists())
        self.assertIn("child", self.git(self.repo, "branch", "--list", "child"))

    def test_restartable_prune_closed_entry_on_the_same_worktree_keeps_it(self):
        self.registry({"child": "other-pruned", "status": "closed", "closedBy": "prune"})
        self.assertIsNotNone(fsn.remove_closed_worktree(self.adir, self.entry, []))
        self.assertTrue(self.wt.exists())

    def test_sole_closed_entry_is_removed(self):
        self.registry()
        self.assertIsNone(fsn.remove_closed_worktree(self.adir, self.entry, []))
        self.assertFalse(self.wt.exists())
        self.assertEqual(self.git(self.repo, "branch", "--list", "child").strip(), "")


class MarkedOnlyTest(LocalRestartBase):
    def reap(self):
        with mock.patch.object(fsn, "remove_closed_worktree", return_value=None) as wt:
            code, out, err = self.run_main("list")
        self.assertEqual(code, 0, err)
        return wt

    def test_old_closed_entry_without_the_mark_keeps_its_worktree(self):
        self.write_entry(status="closed")
        wt = self.reap()
        wt.assert_not_called()
        self.assertTrue(self.stored()["reaped"])
        self.assertFalse(self.stored().get("worktreeDone"))

    def test_marked_entry_is_removed_and_unmarked(self):
        self.write_entry(status="closed", worktreePending=True)
        self.reap().assert_called_once()
        stored = self.stored()
        self.assertTrue(stored["worktreeDone"])
        self.assertFalse(stored["worktreePending"])


class ReapMarkTest(LocalRestartBase):
    def test_entry_reopened_by_a_restart_is_not_marked_reaped(self):
        self.write_entry(status="closed")
        real = fsn.reap_local_terminal

        def reap_then_restart(binary, entry, now):
            result = real(binary, entry, now)
            fsn.update_entry(self.padir, CHILD, {"status": "open", "restartedEpoch": time.time()}, drop=("reaped",))
            return result

        with mock.patch.object(fsn, "reap_local_terminal", side_effect=reap_then_restart):
            fsn.reap_local_closed(self.padir, open(os.devnull, "w"))
        stored = self.stored()
        self.assertEqual(stored["status"], "open")
        self.assertNotIn("reaped", stored)


class LockTest(unittest.TestCase):
    def test_a_stale_lock_is_taken_by_exactly_one_of_many_runs(self):
        tmp = Path(tempfile.mkdtemp(prefix="rev_lock_"))
        self.addCleanup(shutil.rmtree, str(tmp), True)
        path = tmp / "x.lock"
        path.write_text("x", "utf-8")
        old = time.time() - 3600
        os.utime(path, (old, old))
        holders, inside, errors = [], [], []
        gate = threading.Barrier(6)

        def run():
            gate.wait()
            try:
                with fsn.FileLock(path, 120):
                    inside.append(1)
                    holders.append(len(inside))
                    time.sleep(0.3)
                    inside.pop()
            except fsn.Refused:
                errors.append(1)

        threads = [threading.Thread(target=run) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(holders) + len(errors), 6)
        self.assertEqual(max(holders), 1, "two runs held the lock at once")
        self.assertGreaterEqual(len(holders), 1)

    def test_a_fresh_lock_is_never_removed(self):
        tmp = Path(tempfile.mkdtemp(prefix="rev_lock_"))
        self.addCleanup(shutil.rmtree, str(tmp), True)
        path = tmp / "x.lock"
        path.write_text("x", "utf-8")
        with self.assertRaises(fsn.Refused):
            with fsn.FileLock(path, 120):
                pass
        self.assertTrue(path.exists())


class StartingTest(LocalRestartBase):
    def test_a_restart_right_after_a_restart_is_refused(self):
        self.write_entry(restartedEpoch=time.time() - 5)
        code, out, err = self.restart()
        self.assertEqual(code, 1, out)
        self.assertIn("still starting", out + err)
        self.assertEqual(self.hc_calls("run"), [])

    def test_an_old_restart_does_not_block(self):
        self.write_entry(restartedEpoch=time.time() - fsn.RESTART_START_GRACE - 5)
        with mock.patch.object(fsn, "hc_terminal_addresses", return_value={"t0"}):
            code, out, err = self.restart()
        self.assertEqual(code, 0, err)
        self.assertGreater(self.stored()["restartedEpoch"], time.time() - 30)


if __name__ == "__main__":
    unittest.main()
