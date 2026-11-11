"""The default worktreeDisposable list carries the file that the mod check tool writes (gpui-kit.d.ts): merged worktrees holding only it are cleaned; jsconfig.json, which people write by hand, still offends (temp repos only)."""
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

MOD = "integrations/herdr-app/x/"


def g(cwd, *args):
    subprocess.run(["git", "-c", "user.name=T", "-c", "user.email=t@example.invalid"] + list(args), cwd=str(cwd),
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)


def put(root, rel, text="x\n"):
    p = Path(root, *rel.split("/"))
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    return p


class GpuiKitMatcherTest(unittest.TestCase):
    def test_file_entry_matches_a_file_at_any_depth(self):
        d = safe_ops.DEFAULT_DISPOSABLE
        self.assertTrue(safe_ops.disposable("gpui-kit.d.ts", d))
        self.assertTrue(safe_ops.disposable(MOD + "gpui-kit.d.ts", d))

    def test_folder_of_that_name_is_not_matched(self):
        d = safe_ops.DEFAULT_DISPOSABLE
        self.assertFalse(safe_ops.disposable("gpui-kit.d.ts/", d))
        self.assertFalse(safe_ops.disposable(MOD + "gpui-kit.d.ts/", d))
        self.assertFalse(safe_ops.disposable(MOD + "gpui-kit.d.ts/index.d.ts", d))

    def test_jsconfig_is_not_in_the_defaults(self):
        self.assertFalse(safe_ops.disposable("jsconfig.json", safe_ops.DEFAULT_DISPOSABLE))
        self.assertFalse(safe_ops.disposable(MOD + "jsconfig.json", safe_ops.DEFAULT_DISPOSABLE))


class ModLitterWorktreeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="mod_litter_test_")))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        patch = mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})
        patch.start()
        self.addCleanup(patch.stop)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        g(self.repo, "init", "-q", "-b", "main")
        put(self.repo, "README")
        put(self.repo, ".gitignore", "*\n!README\n!.gitignore\n")  # every untracked path is ignored
        g(self.repo, "add", ".")
        g(self.repo, "commit", "-q", "-m", "init")
        self.wt = self.tmp / "repo.worktrees" / "feat"
        g(self.repo, "worktree", "add", "-q", "-b", "feat", str(self.wt))
        self.cfg = safe_ops.ops_config({})

    def check(self):
        return safe_ops.check_worktree(str(self.wt), str(self.wt), self.cfg)

    def wipe(self):
        """Remove every untracked path from the worktree."""
        for p in self.wt.iterdir():
            if p.name in ("README", ".gitignore", ".git"):
                continue
            shutil.rmtree(str(p)) if p.is_dir() and not p.is_symlink() else p.unlink()

    def refused(self):
        with self.assertRaises(safe_ops.Precondition) as cm:
            self.check()
        self.assertEqual(cm.exception.name, "ignored_files")
        return cm.exception

    def test_gpui_kit_file_at_any_depth_is_cleaned(self):
        for rel in (MOD + "gpui-kit.d.ts", "gpui-kit.d.ts"):
            with self.subTest(rel=rel):
                try:
                    put(self.wt, rel)
                    self.assertEqual(self.check()["branch"], "feat")
                finally:
                    self.wipe()

    def test_folder_named_gpui_kit_is_refused_and_names_the_file(self):
        rel = MOD + "gpui-kit.d.ts/index.d.ts"
        put(self.wt, rel)
        exc = self.refused()
        self.assertEqual(exc.files, [rel])
        self.assertIn(rel, safe_ops.ignored_text(exc))

    def test_jsconfig_still_offends_and_is_named(self):
        rel = MOD + "jsconfig.json"
        put(self.wt, MOD + "gpui-kit.d.ts")
        put(self.wt, rel)
        exc = self.refused()
        self.assertEqual(exc.files, [rel])
        self.assertEqual(safe_ops.ignored_text(exc), "ignored_files (%s)" % rel)


if __name__ == "__main__":
    unittest.main()
