"""Ignored files and a merged worktree: selfclean check and run, manifest cleanup reason, sweep line (temp repos only)."""
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
import foreman_worktree as fw  # noqa: E402
import safe_ops  # noqa: E402


def g(cwd, *args):
    subprocess.run(["git", "-c", "user.name=T", "-c", "user.email=t@example.invalid"] + list(args), cwd=str(cwd),
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)


def put(root, rel, text="x\n"):
    p = Path(root, *rel.split("/"))
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    return p


class IgnoredFilesRound(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="close_ignored_test_")))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        patch = mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})
        patch.start()
        self.addCleanup(patch.stop)
        self.state = self.tmp / "agent" / "pi-foreman" / "state"
        self.state.mkdir(parents=True)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        g(self.repo, "init", "-q", "-b", "main")
        put(self.repo, "README")
        put(self.repo, ".gitignore", ".pi/\n*.env\n.DS_Store\npkg/\n")
        g(self.repo, "add", ".")
        g(self.repo, "commit", "-q", "-m", "init")
        self.wt = self.tmp / "repo.worktrees" / "feat"
        g(self.repo, "worktree", "add", "-q", "-b", "feat", str(self.wt))
        self.outside = self.tmp / "outside"
        put(self.outside, "keep.txt", "keep\n")

    def selfclean(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = fcl.main(["selfclean", "--ws", str(self.wt), "--branch", "feat", "--state", str(self.state),
                             "--session", "child-1"])
        return code, json.loads(out.getvalue())

    def sweep(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            fw.main(["sweep", "--cwd", str(self.repo), "--state", str(self.state), "--session", "s"])
        return out.getvalue().splitlines()

    def test_task_logs_are_cleaned_by_check_and_sweep(self):
        put(self.wt, ".pi/tasks/t1/x.output")
        code, out = self.selfclean()
        self.assertEqual((code, out["ok"]), (0, True))
        self.assertIn("removed: %s" % self.wt, self.sweep())
        self.assertFalse(self.wt.exists())
        self.assertTrue((self.repo / "README").is_file())

    def test_selfclean_run_removes_the_worktree_with_its_task_logs(self):
        put(self.wt, ".pi/tasks/t1/x.output")
        put(self.wt, ".DS_Store")
        put(self.wt, "pkg/__pycache__/m.pyc")
        result = self.tmp / "cleanup.json"
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            code = fcl.main(["selfclean", "--ws", str(self.wt), "--branch", "feat", "--state", str(self.state),
                             "--session", "child-1", "--wait-pid", "99999999", "--out", str(result)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(result.read_text())["status"], "removed")
        self.assertFalse(self.wt.exists())
        self.assertTrue((self.repo / "README").is_file())
        self.assertEqual((self.outside / "keep.txt").read_text(), "keep\n")

    def test_other_ignored_file_is_refused_and_named(self):
        put(self.wt, ".pi/tasks/t1/x.output")
        put(self.wt, "secret.env")
        code, out = self.selfclean()
        self.assertEqual((code, out["ok"], out["reason"]), (3, False, "ignored_files"))
        self.assertEqual((out["files"], out["filesMore"]), (["secret.env"], 0))
        self.assertIn("skipped: %s — ignored_files (secret.env)" % self.wt, self.sweep())
        self.assertTrue(self.wt.is_dir())

    def test_pi_dir_with_another_file_names_only_that_file(self):
        put(self.wt, ".pi/tasks/t1/x.output")
        put(self.wt, ".pi/settings.json")
        _, out = self.selfclean()
        self.assertEqual(out["files"], [".pi/settings.json"])
        self.assertIn("skipped: %s — ignored_files (.pi/settings.json)" % self.wt, self.sweep())

    def test_manifest_cleanup_reason_names_the_files(self):
        put(self.wt, "a.env")
        reason, chk = fcl.check_entry({"path": str(self.wt), "kind": "worktree"}, str(self.state), "s", safe_ops.ops_config({}))
        self.assertEqual((reason, chk), ("ignored_files (a.env)", None))

    def test_nested_and_symlinked_pi_tasks_are_refused(self):
        put(self.wt, "pkg/.pi/tasks/t1/x.output")
        _, out = self.selfclean()
        self.assertEqual(out["files"], ["pkg/.pi/tasks/t1/x.output"])
        shutil.rmtree(str(self.wt / "pkg"))
        (self.wt / ".pi").mkdir()
        try:
            os.symlink(str(self.outside), str(self.wt / ".pi" / "tasks"), target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks not available")
        _, out = self.selfclean()
        self.assertEqual(out["files"], [".pi/tasks"])
        self.assertIn("skipped: %s — ignored_files (.pi/tasks)" % self.wt, self.sweep())
        self.assertEqual((self.outside / "keep.txt").read_text(), "keep\n")
        self.assertTrue(self.wt.is_dir())

    def test_os_litter_and_pycache_folder_are_cleaned(self):
        put(self.wt, ".DS_Store")
        put(self.wt, "pkg/__pycache__/m.pyc")
        code, out = self.selfclean()
        self.assertEqual((code, out["ok"]), (0, True))
        self.assertIn("removed: %s" % self.wt, self.sweep())

    def test_control_characters_are_cleaned_in_the_line(self):
        if sys.platform == "win32":
            self.skipTest("control characters are not valid in Windows file names")
        put(self.wt, "a\x1b[31mb.env")
        lines = self.sweep()
        self.assertIn("skipped: %s — ignored_files (a?[31mb.env)" % self.wt, lines)
        self.assertFalse(any("\x1b" in ln for ln in lines))

    def test_more_than_three_files_give_a_count(self):
        for n in range(5):
            put(self.wt, "%d.env" % n)
        _, out = self.selfclean()
        self.assertEqual((out["files"], out["filesMore"]), (["0.env", "1.env", "2.env"], 2))
        self.assertIn("skipped: %s — ignored_files (0.env, 1.env, 2.env, +2 more)" % self.wt, self.sweep())

    def test_non_utf8_file_name_is_cleaned_in_the_sweep_output(self):
        if sys.platform in ("win32", "darwin"):
            self.skipTest("the file system refuses or re-encodes non-UTF-8 names")
        try:
            with open(os.fsencode(str(self.wt)) + b"/a\xff.env", "wb") as fh:
                fh.write(b"x\n")
        except OSError:
            self.skipTest("non-UTF-8 file names are not supported here")
        lines = self.sweep()
        "\n".join(lines).encode("utf-8")
        self.assertIn("skipped: %s — ignored_files (a?.env)" % self.wt, lines)


if __name__ == "__main__":
    unittest.main()
