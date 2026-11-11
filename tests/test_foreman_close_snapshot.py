"""scripts/foreman_close.py: the self-finish snapshot of `.workflow/` (scope, cap, links, age) and the default-branch refusal (temp repos only)."""
from __future__ import annotations

import contextlib
import io
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

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_close as fcl  # noqa: E402

MIB = 1024 * 1024


def g(cwd, *args):
    r = subprocess.run(["git", "-c", "user.name=T", "-c", "user.email=t@example.invalid"] + list(args), cwd=str(cwd),
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    return r.stdout.decode().strip()


def tree_bytes(root):
    return sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(root) for f in fs)


def tree_files(root):
    return sorted(os.path.relpath(os.path.join(d, f), root).replace(os.sep, "/") for d, _, fs in os.walk(root) for f in fs)


class Snapshot(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="snapshot_test_")))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        patch = mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})
        patch.start()
        self.addCleanup(patch.stop)
        self.state = self.tmp / "agent" / "pi-foreman" / "state"
        self.state.mkdir(parents=True)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        g(self.repo, "init", "-q", "-b", "main")
        (self.repo / "README").write_text("x\n")
        (self.repo / ".gitignore").write_text(".workflow/\n")
        g(self.repo, "add", ".")
        g(self.repo, "commit", "-q", "-m", "init")
        self.wt = self.tmp / "wt"
        g(self.repo, "worktree", "add", "-q", "-b", "feat", str(self.wt))
        (self.wt / "f.txt").write_text("feature\n")
        g(self.wt, "add", "f.txt")
        g(self.wt, "commit", "-q", "-m", "feature")
        self.tip = g(self.wt, "rev-parse", "HEAD")
        g(self.repo, "merge", "--squash", "feat")
        g(self.repo, "commit", "-q", "-m", "feature (squash)")
        self.src = self.wt / ".workflow"
        self.src.mkdir()
        (self.src / "LEDGER.md").write_text("# l\n")
        self.handoff = self.tmp / "handoff"
        self.handoff.mkdir()

    def selfclean(self, *extra, ws=None, branch="feat"):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = fcl.main(["selfclean", "--ws", str(ws or self.wt), "--branch", branch, "--state", str(self.state),
                             "--session", "child-1", *extra])
        return code, json.loads(out.getvalue())

    def put(self, rel, data=b"x", root=None):
        p = (root or self.src) / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return p

    def test_a_closed_folder_full_of_data_stays_out_of_the_snapshot(self):
        self.put("closed/round-1/big.bin", b"\0" * (5 * MIB))
        self.put("closed/round-2/big.bin", b"\0" * (5 * MIB))
        self.put("scratch/plan.md", b"plan\n")
        dest = self.handoff / "workflow"
        snap = fcl.archive_workflow(str(self.wt), str(dest))
        before, after = tree_bytes(self.src), tree_bytes(dest)
        print("snapshot sizes: source .workflow %d bytes, snapshot %d bytes" % (before, after), file=sys.stderr)
        self.assertGreater(before, 10 * MIB)
        self.assertLess(after, 1024)
        self.assertEqual((snap["bytes"], snap["files"]), (after, 2))
        self.assertIn("closed/ (other rounds)", snap["leftOut"])

    def test_a_snapshot_never_contains_a_snapshot(self):
        self.put("closed/demo/workflow/LEDGER.md", b"old\n")
        self.put("archive/earlier/LEDGER.md", b"old\n")
        self.put("scratch/plan.md", b"plan\n")
        dest = self.src / "handoff" / "workflow"  # the destination lies inside the source
        fcl.archive_workflow(str(self.wt), str(dest))
        fcl.archive_workflow(str(self.wt), str(dest))  # and a second snapshot into the same place
        self.assertEqual(tree_files(dest), ["LEDGER.md", "scratch/plan.md"])
        shutil.rmtree(str(self.src / "handoff"))
        sep = self.handoff / "workflow"  # a destination outside the source
        snap = fcl.archive_workflow(str(self.wt), str(sep))
        self.assertEqual(tree_files(sep), ["LEDGER.md", "scratch/plan.md"])
        self.assertEqual(len(snap["leftOut"]), 2)

    def test_over_the_cap_files_are_left_out_and_named(self):
        self.put("big.bin", b"\0" * (17 * MIB))
        self.put("small.md", b"s\n")
        code, out = self.selfclean("--verified-merged", self.tip, "--archive", str(self.handoff / "workflow"))
        self.assertEqual(out["archived"], 2)
        self.assertEqual(out["leftOut"], ["1 files over the 16 MiB cap: big.bin"])
        self.assertTrue((self.handoff / "workflow" / "small.md").is_file())
        self.assertFalse((self.handoff / "workflow" / "big.bin").exists())

    def test_the_cap_is_shared_by_both_snapshots_of_one_close(self):
        self.put("a.bin", b"\0" * (10 * MIB))
        other = self.tmp / "other"
        self.put("b.bin", b"\0" * (10 * MIB), root=other / ".workflow")
        budget = [fcl.SNAPSHOT_CAP]
        first = fcl.archive_workflow(str(self.wt), str(self.handoff / "w1"), budget=budget)
        second = fcl.archive_workflow(str(other), str(self.handoff / "w2"), budget=budget)
        self.assertEqual((first["files"], second["files"]), (2, 0))
        self.assertEqual(second["leftOut"], ["1 files over the 16 MiB cap: b.bin"])

    def test_no_symlink_is_followed_or_copied(self):
        outside = self.tmp / "outside"
        outside.mkdir()
        (outside / "secret.txt").write_text("secret\n")
        try:
            os.symlink(str(outside / "secret.txt"), str(self.src / "link-file"))
            os.symlink(str(outside), str(self.src / "link-dir"), target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks are not available here")
        dest = self.handoff / "workflow"
        snap = fcl.archive_workflow(str(self.wt), str(dest))
        self.assertEqual(tree_files(dest), ["LEDGER.md"])
        self.assertFalse(any(os.path.islink(os.path.join(d, n)) for d, ds, fs in os.walk(dest) for n in ds + fs))
        self.assertIn("2 links", snap["leftOut"])

    def test_older_files_of_the_main_worktree_are_left_out_and_the_bound_ledger_is_kept(self):
        old = time.time() - 3600
        main_wf = self.repo / ".workflow"
        ledger = self.put("LEDGER-x.md", b"# ledger\n", root=main_wf)
        self.put("scratch/old.md", b"old\n", root=main_wf)
        self.put("scratch/new.md", b"new\n", root=main_wf)
        for rel in ("LEDGER-x.md", "scratch/old.md"):
            os.utime(main_wf / rel, (old, old))
        (self.state / "fable-orch-model-child-1.json").write_text(json.dumps({"ledger": str(ledger)}))
        code, out = self.selfclean("--verified-merged", self.tip, "--archive", str(self.handoff / "workflow"),
                                   "--session-cwd", str(self.repo), "--since", str(time.time() - 60))
        self.assertEqual(tree_files(self.handoff / "workflow-cwd"), ["LEDGER-x.md", "scratch/new.md"])
        self.assertEqual(out["leftOut"], ["session cwd: 1 files older than the session"])
        code, out = self.selfclean("--verified-merged", self.tip, "--archive", str(self.handoff / "w2"), "--ws", str(self.repo), "--since", str(time.time() - 60))
        self.assertEqual(tree_files(self.handoff / "w2"), ["LEDGER-x.md", "scratch/new.md"])
        self.assertEqual(out["leftOut"], ["1 files older than the session"])

    def test_older_files_of_a_linked_worktree_are_kept_and_it_is_still_removed(self):
        old = time.time() - 3600
        self.put("scratch/opener.md", b"from the opener\n")
        for rel in ("LEDGER.md", "scratch/opener.md"):
            os.utime(self.src / rel, (old, old))
        code, out = self.selfclean("--verified-merged", self.tip, "--archive", str(self.handoff / "workflow"), "--since", str(time.time()))
        self.assertEqual((code, out["ok"], out["leftOut"]), (0, True, []))
        self.assertEqual(tree_files(self.handoff / "workflow"), ["LEDGER.md", "scratch/opener.md"])

    def test_the_session_cwd_workflow_goes_to_workflow_cwd(self):
        self.put("notes.md", b"n\n", root=self.repo / ".workflow")
        code, out = self.selfclean("--verified-merged", self.tip, "--archive", str(self.handoff / "workflow"), "--session-cwd", str(self.repo))
        self.assertEqual((code, out["archivedCwd"]), (0, 1))
        self.assertTrue((self.handoff / "workflow-cwd" / "notes.md").is_file())
        self.assertTrue((self.handoff / "workflow" / "LEDGER.md").is_file())

    def test_closed_and_archive_match_in_any_case(self):
        self.put("Closed/round-1/big.bin", b"\0" * MIB)
        self.put("ARCHIVE/earlier/LEDGER.md", b"old\n")
        dest = self.handoff / "workflow"
        snap = fcl.archive_workflow(str(self.wt), str(dest))
        self.assertEqual(tree_files(dest), ["LEDGER.md"])
        self.assertEqual(sorted(snap["leftOut"]), ["archive/ (earlier snapshots)", "closed/ (other rounds)"])

    def test_a_special_entry_is_listed_in_left_out_and_keeps_the_worktree(self):
        if not hasattr(os, "mkfifo"):
            self.skipTest("no FIFO here")
        os.mkfifo(str(self.src / "pipe"))
        dest = self.handoff / "workflow"
        snap = fcl.archive_workflow(str(self.wt), str(dest))
        self.assertEqual(tree_files(dest), ["LEDGER.md"])
        self.assertEqual(snap["leftOut"], ["1 unreadable or special entries"])
        code, out = self.selfclean("--verified-merged", self.tip, "--archive", str(self.handoff / "w2"))
        self.assertEqual((code, out["reason"]), (3, "ignored_files"))
        self.assertEqual(out["leftOut"], ["1 unreadable or special entries"])

    def test_an_unreadable_folder_is_listed_in_left_out(self):
        locked = self.src / "locked"
        locked.mkdir()
        self.put("locked/a.md", b"a\n")
        os.chmod(str(locked), 0)
        self.addCleanup(os.chmod, str(locked), 0o700)
        if os.name == "nt" or os.access(str(locked), os.R_OK):
            self.skipTest("cannot make a folder unreadable here")
        snap = fcl.archive_workflow(str(self.wt), str(self.handoff / "workflow"))
        self.assertEqual(snap["leftOut"], ["1 unreadable or special entries"])

    def test_something_left_out_of_a_linked_worktree_keeps_it(self):
        self.put("big.bin", b"\0" * (17 * MIB))
        code, out = self.selfclean("--verified-merged", self.tip, "--archive", str(self.handoff / "workflow"))
        self.assertEqual((code, out["ok"], out["reason"]), (3, False, "ignored_files"))
        self.assertTrue(self.wt.is_dir())

    def test_the_main_checkout_is_refused(self):
        code, out = self.selfclean("--verified-merged", g(self.repo, "rev-parse", "HEAD"), ws=self.repo, branch="main")
        self.assertEqual(code, 3)
        self.assertIn(out["reason"], ("main_worktree", "default_branch"))

    def test_the_default_branch_in_a_linked_worktree_is_refused(self):
        g(self.repo, "checkout", "-q", "-b", "other")  # main is free for a second worktree
        second = self.tmp / "second"
        g(self.repo, "worktree", "add", "-q", str(second), "main")
        code, out = self.selfclean("--verified-merged", g(second, "rev-parse", "HEAD"), ws=second, branch="main")
        self.assertEqual((code, out["reason"]), (3, "default_branch"))


if __name__ == "__main__":
    unittest.main()
