"""scripts/foreman_close.py: manifest, CLOSE report, cleanup preconditions and handovers (temp repos only)."""
from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_close as fcl  # noqa: E402
import foreman_sync as fsync  # noqa: E402

SID = "sess-close-1"


def g(cwd, *args):
    r = subprocess.run(["git", "-c", "user.name=T", "-c", "user.email=t@example.invalid"] + list(args), cwd=str(cwd),
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    return r.stdout.decode().strip()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="close_test_")))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        env = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
        patch = mock.patch.dict(os.environ, env)
        patch.start()
        self.addCleanup(patch.stop)
        for k in ("PI_FOREMAN_PARENT_INTERCOM", "PI_SUBAGENT_PARENT_SESSION", "CLAUDE_CODE_SESSION_ID", "PI_FOREMAN_STATE_DIR"):
            os.environ.pop(k, None)
        self.agent = self.tmp / "agent"
        self.state = self.agent / "pi-foreman" / "state"
        self.state.mkdir(parents=True)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        g(self.repo, "init", "-q")
        (self.repo / "README").write_text("x\n")
        g(self.repo, "add", "README")
        g(self.repo, "commit", "-q", "-m", "init")
        g(self.repo, "branch", "-M", "main")

    def cli(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = fcl.main(list(args) + ["--session", SID, "--state", str(self.state)])
        return code, out.getvalue()

    def report(self, *extra):
        code, out = self.cli("--cwd", str(self.repo), "--json", *extra)
        return code, json.loads(out)

    def record(self, kind, path, sid=SID):
        fcl.record(str(self.state), sid, kind, str(path))

    def worktree(self, name, commit=False, dirty=False):
        path = self.tmp / name
        g(self.repo, "worktree", "add", "-q", "-b", name, str(path))
        if commit:
            (path / "new").write_text("n\n")
            g(path, "add", "new")
            g(path, "commit", "-q", "-m", "work")
        if dirty:
            (path / "dirty").write_text("d\n")
        self.record("worktree", path)
        return path

    def live(self, sid, cwd, state="working", intercom=None, parent=None):
        d = self.state / "live"
        d.mkdir(exist_ok=True)
        (d / ("%s.json" % sid)).write_text(json.dumps({"sessionId": sid, "intercomId": intercom, "parentIntercom": parent,
                                                        "cwd": str(cwd), "state": state}))


class ManifestTest(Base):
    def test_append_dedups_by_realpath(self):
        d = self.repo / ".workflow" / "scratch" / "t"
        d.mkdir(parents=True)
        self.record("scratch", d)
        self.record("scratch", str(d) + os.sep)
        m = fcl.load_manifest(str(self.state), SID)
        self.assertEqual(len(m["entries"]), 1)
        self.assertEqual(m["entries"][0]["kind"], "scratch")
        self.record("handoff", self.tmp)
        self.assertEqual(fcl.load_manifest(str(self.state), SID)["entries"][1]["class"], "durable")

    def test_concurrent_append_keeps_every_entry(self):
        procs = [subprocess.Popen([sys.executable, str(SCRIPTS / "foreman_close.py"), "record", "--kind", "scratch",
                                   "--path", str(self.tmp / ("p%d" % i)), "--session", SID, "--state", str(self.state)])
                 for i in range(8)]
        self.assertEqual([p.wait(timeout=60) for p in procs], [0] * 8)
        paths = sorted(os.path.basename(e["path"]) for e in fcl.load_manifest(str(self.state), SID)["entries"])
        self.assertEqual(paths, ["p%d" % i for i in range(8)])


class ReportTest(Base):
    def test_ready_then_open_on_ledger_item(self):
        code, rep = self.report()
        self.assertEqual((code, rep["lines"][0]), (0, "CLOSE: ready"))
        self.assertTrue((self.state / "sessions" / SID / "close.json").is_file())
        ledger = self.tmp / "LEDGER.md"
        ledger.write_text("- [x] 1. done\n- [~] deferred: later — 2. b\n```\n- [ ] 9. fenced\n```\n- [ ] 3. open one\n")
        (self.state / ("fable-orch-model-%s.json" % SID)).write_text(json.dumps({"ledger": str(ledger)}))
        code, rep = self.report()
        self.assertEqual((code, rep["openItems"]), (3, ["3. open one"]))
        self.assertIn("open item: 3. open one", rep["lines"])

    def test_merged_removed_dirty_unmerged_in_use_handed_over(self):
        merged = self.worktree("merged")
        dirty = self.worktree("dirty", dirty=True)
        unmerged = self.worktree("unmerged", commit=True)
        busy = self.worktree("busy")
        self.live("other", busy / "sub")
        code, rep = self.report()
        reasons = {os.path.basename(h["path"]): h["reason"] for h in rep["handovers"]}
        self.assertEqual(reasons, {"dirty": "worktree_dirty", "unmerged": "not_merged", "busy": "in_use (session other)"})
        self.assertEqual([os.path.basename(p) for p in rep["removed"]], ["merged"])
        self.assertFalse(merged.exists())
        self.assertTrue(dirty.exists() and unmerged.exists() and busy.exists())
        self.assertEqual(code, 3)  # a top session's own handovers block
        self.assertIn("handover: %s — worktree_dirty" % dirty, rep["lines"])

    def test_unmerged_created_branch_and_uncommitted(self):
        g(self.repo, "checkout", "-q", "-b", "feat")
        (self.repo / "f").write_text("1\n")
        g(self.repo, "add", "f")
        g(self.repo, "commit", "-q", "-m", "f")
        (self.repo / "loose").write_text("u\n")
        (self.state / "created-branches.json").write_text(json.dumps(
            {"branches": [{"workspace": str(self.repo), "branch": "feat", "session": SID}]}))
        code, rep = self.report()
        self.assertEqual(code, 3)
        self.assertEqual(rep["unmerged"], [{"branch": "feat", "workspace": str(self.repo)}])
        self.assertEqual(rep["uncommitted"][0]["paths"], ["loose"])

    def test_dry_run_removes_and_writes_nothing(self):
        wt = self.worktree("merged")
        code, out = self.cli("--cwd", str(self.repo), "--dry-run")
        self.assertIn("would remove: %s" % wt, out)
        self.assertTrue(wt.exists())
        self.assertFalse((self.state / "sessions" / SID / "close.json").exists())

    def test_autoclean_off_hands_over_and_parent_keeps_ready(self):
        (self.agent / "foreman.json").write_text(json.dumps({"close": {"autoClean": False}}))
        wt = self.worktree("merged")
        self.live(SID, self.repo, intercom="me", parent="boss")
        code, rep = self.report()
        self.assertEqual(rep["handovers"][0]["reason"], "autoClean off")
        self.assertTrue(wt.exists())
        self.assertEqual((code, rep["parent"]), (0, "boss"))

    def test_scratch_guard_outside_and_symlink_never_removed(self):
        outside = self.tmp / "notscratch"
        outside.mkdir()
        inside = self.repo / ".workflow" / "scratch" / "topic"
        inside.mkdir(parents=True)
        (inside / "a.txt").write_text("a\n")
        self.record("scratch", outside)
        link = None
        try:
            target = self.repo / ".workflow" / "scratch" / "real"
            target.mkdir()
            link = self.repo / ".workflow" / "scratch" / "link"
            os.symlink(str(target), str(link), target_is_directory=True)
            self.record("scratch", link)
        except (OSError, NotImplementedError):
            link = None
        self.record("scratch", inside)
        with mock.patch.object(fcl.shutil, "which", return_value=None):
            code, rep = self.report()
        reasons = {os.path.basename(h["path"]): h["reason"] for h in rep["handovers"]}
        self.assertEqual(reasons.get("notscratch"), "outside_scratch")
        self.assertTrue(outside.is_dir())
        if link is not None:
            self.assertEqual(reasons.get("link"), "symlink")
            self.assertTrue(link.is_symlink() and target.is_dir())
        self.assertFalse(inside.exists())
        self.assertFalse(fcl.scratch_guard(str(self.state / "scratch"), str(self.state)) is None)


class HandoverTest(Base):
    def child_close(self, path):
        child = self.state / "sessions" / "child-1"
        child.mkdir(parents=True)
        (child / "close.json").write_text(json.dumps({"v": 1, "session": "child-1", "parent": "me-ic", "handovers": [
            {"path": str(path), "reason": "worktree_dirty", "kind": "worktree", "branch": "x"}]}))

    def test_untaken_child_handover_relisted_until_taken_or_dropped(self):
        self.live(SID, self.repo, intercom="me-ic")
        left = self.tmp / "left"
        left.mkdir()
        self.child_close(left)
        code, rep = self.report()
        self.assertEqual(code, 3)
        self.assertIn("child handover: %s — worktree_dirty (from child-1)" % left, rep["lines"])
        self.assertEqual(self.cli("--drop", str(left))[0], 0)
        code, rep = self.report("--dry-run")
        self.assertEqual((code, rep["childHandovers"]), (0, []))
        self.assertEqual(self.cli("--take", str(left))[0], 0)
        m = fcl.load_manifest(str(self.state), SID)
        self.assertEqual((m["dropped"], m["entries"][0]["kind"], m["entries"][0]["branch"]), ([], "worktree", "x"))

    def test_sync_shows_close_block_first(self):
        (self.agent / "foreman.json").write_text(json.dumps({"sync": {"repos": [], "runRetro": False}}))
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = fsync.main(["--cwd", str(self.repo), "--state", str(self.state), "--session", SID])
        lines = out.getvalue().splitlines()
        self.assertEqual((code, lines[:2]), (0, ["pi-foreman sync", "CLOSE: ready"]))
        self.assertTrue((self.state / "sessions" / SID / "close.json").is_file())


if __name__ == "__main__":
    unittest.main()
