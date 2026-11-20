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
from test_foreman_session_restart import LocalRestartBase, CHILD
import foreman_session as fsn


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
        return subprocess.run(["git", "-C", str(cwd), "-c", "core.autocrlf=false"] + list(args), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=True).stdout.decode()

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
            fsn.reap_local_closed(self.padir, open(os.devnull, "w", encoding="utf-8"))
        stored = self.stored()
        self.assertEqual(stored["status"], "open")
        self.assertNotIn("reaped", stored)


LOCK_HOLDER = """
import os, sys, time
sys.path.insert(0, sys.argv[1])
import foreman_session as fsn
lock, marker, rounds, mode = sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]
bad = 0
for _ in range(rounds):
    with fsn.FileLock(lock, wait=60):
        try:
            os.close(os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY))  # a second holder at once finds it there
        except FileExistsError:
            bad += 1
        if mode == "die":
            print("held", flush=True)
            time.sleep(60)
        time.sleep(0.002)
        try:
            os.unlink(marker)
        except OSError:
            bad += 1
print("bad", bad)
"""


class LockTest(unittest.TestCase):
    SCRIPTS = os.path.join(os.path.dirname(__file__), "..", "scripts")

    def spawn(self, lock, marker, rounds, mode="loop"):
        return subprocess.Popen([sys.executable, "-c", LOCK_HOLDER, self.SCRIPTS, str(lock), str(marker), str(rounds), mode],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8")

    def tmpdir(self):
        tmp = Path(tempfile.mkdtemp(prefix="rev_lock_"))
        self.addCleanup(shutil.rmtree, str(tmp), True)
        return tmp

    def test_many_processes_never_hold_the_lock_at_once(self):
        tmp = self.tmpdir()
        procs = [self.spawn(tmp / "x.lock", tmp / "held", 25) for _ in range(8)]
        for proc in procs:
            out, err = proc.communicate(timeout=120)
            self.assertEqual(proc.returncode, 0, err)
            self.assertEqual(out.strip(), "bad 0", "two runs held the lock at once")

    def test_a_holder_that_dies_frees_the_lock(self):
        tmp = self.tmpdir()
        dying = self.spawn(tmp / "x.lock", tmp / "held", 1, "die")
        self.assertEqual(dying.stdout.readline().strip(), "held")
        with self.assertRaises(fsn.Refused):
            with fsn.FileLock(tmp / "x.lock", wait=0.2):
                pass
        dying.kill()
        dying.communicate()
        started = time.time()
        with fsn.FileLock(tmp / "x.lock", wait=10):
            pass
        self.assertLess(time.time() - started, 5)

    def test_a_held_lock_is_busy_after_the_wait_with_the_given_error(self):
        tmp = self.tmpdir()
        with fsn.FileLock(tmp / "x.lock"):
            with self.assertRaises(fsn.Refused) as cm:
                with fsn.FileLock(tmp / "x.lock", wait=0.1, busy=fsn.Refused("busy now", "registry_busy")):
                    pass
        self.assertEqual(cm.exception.code, "registry_busy")
        with fsn.FileLock(tmp / "x.lock"):
            pass

    def test_an_old_lock_file_is_no_lock(self):
        tmp = self.tmpdir()
        (tmp / "x.lock").write_text("x", encoding="utf-8")
        old = time.time() - 3600
        os.utime(tmp / "x.lock", (old, old))
        with fsn.FileLock(tmp / "x.lock"):
            pass
        self.assertTrue((tmp / "x.lock").exists())


class WriterLockTest(LocalRestartBase):
    def test_prune_probes_that_run_while_a_restart_reopens_the_entry_leave_it_open(self):
        self.write_entry(status="open")

        def probe_then_restart(entry, live, now, hc_addr, herdr_ids):
            fsn.update_entry(self.padir, CHILD, {"hc": {"address": "t9", "parent": "t0", "space": None},
                                                 "restartedEpoch": time.time()})
            return True

        with mock.patch.object(fsn, "entry_gone", side_effect=probe_then_restart), \
                mock.patch.object(fsn, "hc_terminal_addresses", return_value=set()), \
                mock.patch.object(fsn, "herdr_pane_ids", return_value=set()):
            code, out, err = self.run_main("prune")
        self.assertEqual(code, 0, err)
        stored = self.stored()
        self.assertEqual(stored["status"], "open")
        self.assertEqual(stored["hc"]["address"], "t9")
        self.assertNotIn("closedBy", stored)
        self.assertIn("0 pruned", out)

    def test_prune_still_closes_an_entry_nobody_touched(self):
        self.write_entry(status="open")
        with mock.patch.object(fsn, "entry_gone", return_value=True), \
                mock.patch.object(fsn, "hc_terminal_addresses", return_value=set()), \
                mock.patch.object(fsn, "herdr_pane_ids", return_value=set()):
            code, out, err = self.run_main("prune")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.stored()["status"], "closed")
        self.assertEqual(self.stored()["closedBy"], "prune")

    def blocked_until_released(self, write):
        done = threading.Event()
        with fsn.registry_lock(self.padir):
            t = threading.Thread(target=lambda: (write(), done.set()))
            t.start()
            self.assertFalse(done.wait(0.4), "the writer did not wait for the registry lock")
        t.join(10)
        self.assertTrue(done.is_set())

    def test_mark_entry_and_settle_entry_wait_for_the_registry_lock(self):
        self.write_entry(status="open")
        self.blocked_until_released(lambda: fsn.mark_entry(self.padir, self.entry, lastError="x"))
        self.assertEqual(self.stored()["lastError"], "x")
        self.blocked_until_released(lambda: fsn.settle_entry(self.padir, self.stored(), leftAloneAt=5))
        self.assertEqual(self.stored()["leftAloneAt"], 5)


class RestartRegistryBusyTest(LocalRestartBase):
    def setUp(self):
        super().setUp()
        self.write_entry()

    def test_a_busy_registry_is_retried_with_a_longer_wait(self):
        real, waits = fsn.update_entry, []

        def flaky(adir, child, fields, drop=(), wait=10.0):
            waits.append(wait)
            if len(waits) == 1:
                raise fsn.Refused("the session registry is busy", "registry_busy")
            return real(adir, child, fields, drop, wait)

        with mock.patch.object(fsn, "update_entry", side_effect=flaky), \
                mock.patch.object(fsn, "hc_terminal_addresses", return_value={"t0"}):
            code, out, err = self.restart()
        self.assertEqual(code, 0, err)
        self.assertEqual(waits, [10.0, fsn.RESTART_REGISTRY_RETRY])
        self.assertEqual(self.stored()["status"], "open")
        self.assertNotEqual(self.stored()["hc"]["address"], "t1")

    def test_a_final_failure_reports_the_new_address_and_leaves_the_new_pi_running(self):
        busy = fsn.Refused("the session registry is busy", "registry_busy")
        with mock.patch.object(fsn, "update_entry", side_effect=busy), \
                mock.patch.object(fsn, "hc_terminal_addresses", return_value={"t0"}):
            code, out, err = self.restart("demo", "--json")
        self.assertEqual(code, 1, out)
        new = [a for a in self.terminals() if a != "t1"]
        self.assertEqual(len(new), 1)
        self.assertIn("registry_busy", out + err)
        self.assertIn("terminal %s" % new[0], out + err)
        self.assertEqual(self.hc_calls("kill"), [])
        self.assertEqual(self.stored()["hc"]["address"], "t1")


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
