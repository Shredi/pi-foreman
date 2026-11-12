"""safe_ops.check_worktree and disposable(): anchored patterns, the walk of collapsed ignored folders, named files (temp repos only)."""
from __future__ import annotations

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
import safe_ops  # noqa: E402


def g(cwd, *args):
    subprocess.run(["git", "-c", "user.name=T", "-c", "user.email=t@example.invalid"] + list(args), cwd=str(cwd),
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)


def put(root, rel, text="x\n"):
    p = Path(root, *rel.split("/"))
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    return p


class DisposableTest(unittest.TestCase):
    def test_inner_slash_pattern_is_anchored_at_the_top_level(self):
        pats = safe_ops.DEFAULT_DISPOSABLE
        self.assertTrue(safe_ops.disposable(".pi/tasks/", pats))
        self.assertTrue(safe_ops.disposable(".pi/tasks/abc/x.output", pats))
        self.assertFalse(safe_ops.disposable("x/.pi/tasks/", pats))
        self.assertFalse(safe_ops.disposable("x/.pi/tasks/a.output", pats))
        self.assertFalse(safe_ops.disposable(".pi/tasks", pats))  # a file or symlink of that name
        self.assertFalse(safe_ops.disposable(".pi/", pats))
        self.assertFalse(safe_ops.disposable(".pi/settings.json", pats))
        self.assertFalse(safe_ops.disposable(".pi/tasksx/a", pats))

    def test_plain_patterns_keep_their_meaning(self):
        pats = safe_ops.DEFAULT_DISPOSABLE
        self.assertTrue(safe_ops.disposable("a/node_modules/b", pats))
        self.assertTrue(safe_ops.disposable("sub/.DS_Store", pats))
        self.assertTrue(safe_ops.disposable("Thumbs.db", pats))
        self.assertFalse(safe_ops.disposable("a/b.pyc", pats))

    def test_defaults_carry_the_new_entries(self):
        for p in (".pi/tasks/", ".DS_Store", "Thumbs.db"):
            self.assertIn(p, safe_ops.DEFAULT_DISPOSABLE)

    def test_clean_path(self):
        self.assertEqual(safe_ops.clean_path("a\x1b[31m‮b\nc\x9d"), "a?[31m?b?c?")
        self.assertEqual(len(safe_ops.clean_path("a" * 500)), 120)


class CheckWorktreeTest(unittest.TestCase):
    IGNORE = ".pi/\n.workflow/\njunk/\npkg/\n*.env\n*.pyc\n.DS_Store\nx/\n"

    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="ignored_files_test_")))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        patch = mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})
        patch.start()
        self.addCleanup(patch.stop)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        g(self.repo, "init", "-q", "-b", "main")
        put(self.repo, "README")
        put(self.repo, ".gitignore", self.IGNORE)
        g(self.repo, "add", ".")
        g(self.repo, "commit", "-q", "-m", "init")
        self.wt = self.tmp / "wt"
        g(self.repo, "worktree", "add", "-q", "-b", "feat", str(self.wt))
        self.cfg = safe_ops.ops_config({})

    def check(self, **kw):
        return safe_ops.check_worktree(str(self.wt), str(self.wt), self.cfg, **kw)

    def refused(self, **kw):
        with self.assertRaises(safe_ops.Precondition) as cm:
            self.check(**kw)
        self.assertEqual(cm.exception.name, "ignored_files")
        return cm.exception

    def test_task_logs_are_disposable(self):
        put(self.wt, ".pi/tasks/t1/x.output")
        self.assertEqual(self.check()["branch"], "feat")

    def test_other_ignored_file_is_refused_and_named(self):
        put(self.wt, ".pi/tasks/t1/x.output")
        put(self.wt, "a.env")
        exc = self.refused()
        self.assertEqual((exc.files, exc.total), (["a.env"], 1))
        self.assertIn("a.env", exc.detail)

    def test_pi_dir_with_tasks_and_another_file_names_only_the_other(self):
        put(self.wt, ".pi/tasks/t1/x.output")
        put(self.wt, ".pi/settings.json")
        exc = self.refused()
        self.assertEqual(exc.files, [".pi/settings.json"])

    def test_pi_dir_with_only_tasks_and_empty_dirs_passes(self):
        put(self.wt, ".pi/tasks/t1/x.output")
        (self.wt / ".pi" / "empty").mkdir()
        self.check()

    def test_nested_pi_tasks_is_refused(self):
        put(self.wt, "x/.pi/tasks/t1/x.output")
        exc = self.refused()
        self.assertEqual(exc.files, ["x/.pi/tasks/t1/x.output"])

    def test_symlinked_pi_tasks_is_refused_and_not_followed(self):
        outside = self.tmp / "outside"
        put(outside, "keep.txt", "keep\n")
        (self.wt / ".pi").mkdir()
        try:
            os.symlink(str(outside), str(self.wt / ".pi" / "tasks"), target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks not available")
        exc = self.refused()
        self.assertEqual(exc.files, [".pi/tasks"])
        self.assertEqual((outside / "keep.txt").read_text(encoding="utf-8"), "keep\n")

    def test_symlink_inside_a_walked_folder_is_a_leaf(self):
        outside = self.tmp / "outside"
        put(outside, "keep.pyc")
        (self.wt / "junk").mkdir()
        try:
            os.symlink(str(outside), str(self.wt / "junk" / "link"), target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks not available")
        self.assertEqual(self.refused().files, ["junk/link"])

    def test_os_litter_and_pycache_only_folder_are_cleaned(self):
        put(self.wt, ".DS_Store")
        put(self.wt, "pkg/__pycache__/m.cpython-313.pyc")
        put(self.wt, "pkg/sub/.DS_Store")
        self.check()

    def test_pyc_outside_pycache_is_refused(self):
        put(self.wt, "pkg/m.pyc")
        self.assertEqual(self.refused().files, ["pkg/m.pyc"])

    def test_control_characters_are_cleaned(self):
        if sys.platform == "win32":
            self.skipTest("control characters are not valid in Windows file names")
        put(self.wt, "a\x1b[31mb‮.env")
        exc = self.refused()
        self.assertEqual(exc.files, ["a?[31mb?.env"])
        self.assertNotIn("\x1b", exc.detail)

    def test_more_than_three_files_give_a_count(self):
        for n in range(5):
            put(self.wt, "%d.env" % n)
        exc = self.refused()
        self.assertEqual(exc.total, 5)
        self.assertEqual(safe_ops.ignored_text(exc), "ignored_files (0.env, 1.env, 2.env, +2 more)")
        self.assertEqual(safe_ops.ignored_info(exc), {"files": ["0.env", "1.env", "2.env"], "filesMore": 2})

    def test_walk_over_the_cap_names_the_folder(self):
        for n in range(4):
            put(self.wt, "junk/f%d.pyc" % n)
        with mock.patch.object(safe_ops, "IGNORED_WALK_CAP", 3):
            self.assertEqual(self.refused().files, ["junk/"])

    def test_unreadable_folder_names_the_folder(self):
        put(self.wt, "junk/f.pyc")
        with mock.patch.object(safe_ops.os, "scandir", side_effect=PermissionError("no")):
            self.assertEqual(self.refused().files, ["junk/"])

    def test_top_level_exemption_still_applies_inside_a_walk(self):
        put(self.wt, ".workflow/LEDGER.md")
        self.refused()
        self.check(top_level=(".workflow",))

    def test_user_list_replaces_the_defaults(self):
        put(self.wt, ".pi/tasks/t1/x.output")
        self.cfg = safe_ops.ops_config({"worktreeDisposable": ["node_modules/"]})
        self.assertEqual(self.refused().files, [".pi/tasks/t1/x.output"])


class LoneSurrogateTest(unittest.TestCase):
    def test_clean_path_and_text_line_encode_strictly(self):
        name = safe_ops.clean_path("a\udcff.env")
        self.assertEqual(name, "a?.env")
        text = safe_ops.ignored_text(safe_ops.Precondition("ignored_files", "x: %s" % name, [name], 1))
        self.assertEqual(text, "ignored_files (a?.env)")
        text.encode("utf-8")
        self.assertNotRegex(name, "[\ud800-\udfff]")


if __name__ == "__main__":
    unittest.main()
