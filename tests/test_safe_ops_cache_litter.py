"""The default worktreeDisposable list carries the tool caches: merged worktrees holding only caches are cleaned, anything else is named (temp repos only)."""
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
import foreman_worktree as fw  # noqa: E402
import safe_ops  # noqa: E402

DEFAULTS_JSON = SCRIPTS.parent / "config" / "foreman.defaults.json"

CACHES = [".pytest_cache/", ".mypy_cache/", ".ruff_cache/", ".tox/", ".nox/", ".coverage", ".coverage.*", "htmlcov/",
          "*.egg-info/", "*.tsbuildinfo", ".eslintcache", ".nyc_output/", ".next/", ".nuxt/", ".svelte-kit/", ".turbo/",
          ".parcel-cache/"]
# one concrete ignored path per entry (a file inside the folder, or the file itself)
SAMPLES = {
    ".pytest_cache/": ".pytest_cache/v/cache/lastfailed",
    ".mypy_cache/": ".mypy_cache/3.12/meta.json",
    ".ruff_cache/": ".ruff_cache/0.5/x",
    ".tox/": ".tox/py312/log/x.log",
    ".nox/": ".nox/s/bin/python",
    ".coverage": ".coverage",
    ".coverage.*": ".coverage.host.123",
    "htmlcov/": "htmlcov/index.html",
    "*.egg-info/": "pkg.egg-info/PKG-INFO",
    "*.tsbuildinfo": "tsconfig.tsbuildinfo",
    ".eslintcache": ".eslintcache",
    ".nyc_output/": ".nyc_output/out.json",
    ".next/": ".next/cache/x",
    ".nuxt/": ".nuxt/dist/x",
    ".svelte-kit/": ".svelte-kit/output/x",
    ".turbo/": ".turbo/log.txt",
    ".parcel-cache/": ".parcel-cache/data.mdb",
}


def g(cwd, *args):
    subprocess.run(["git", "-c", "user.name=T", "-c", "user.email=t@example.invalid"] + list(args), cwd=str(cwd),
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)


def put(root, rel, text="x\n"):
    p = Path(root, *rel.split("/"))
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    return p


class DisposableGlobTest(unittest.TestCase):
    def test_list_equals_the_config_defaults(self):
        cfg = json.loads(DEFAULTS_JSON.read_text(encoding="utf-8"))
        self.assertEqual(cfg["safety"]["ops"]["worktreeDisposable"], safe_ops.DEFAULT_DISPOSABLE)

    def test_defaults_end_with_the_agreed_caches_in_order(self):
        self.assertEqual(safe_ops.DEFAULT_DISPOSABLE[-len(CACHES):], CACHES)
        self.assertEqual(len(safe_ops.DEFAULT_DISPOSABLE), 10 + len(CACHES))

    def test_glob_stays_inside_one_component(self):
        pats = safe_ops.DEFAULT_DISPOSABLE
        self.assertTrue(safe_ops.disposable("src/app.tsbuildinfo", pats))
        self.assertFalse(safe_ops.disposable("src/app.tsbuildinfo.md", pats))
        self.assertFalse(safe_ops.disposable(".coveragerc", pats))
        self.assertTrue(safe_ops.disposable(".coverage.host.123", pats))
        self.assertFalse(safe_ops.disposable("x.egg-info.bak/a", pats))

    def test_directory_pattern_does_not_match_a_file(self):
        self.assertFalse(safe_ops.disposable(".pytest_cache", safe_ops.DEFAULT_DISPOSABLE))


class InnerSlashEntryTest(unittest.TestCase):
    def test_inner_slash_entry_without_trailing_slash_is_file_only(self):
        self.assertFalse(safe_ops.disposable("a/b/x", ["a/b"]))
        self.assertFalse(safe_ops.disposable("a/b/", ["a/b"]))
        self.assertTrue(safe_ops.disposable("a/b", ["a/b"]))
        self.assertFalse(safe_ops.disposable("x/a/b", ["a/b"]))

    def test_inner_slash_folder_entry_covers_everything_inside(self):
        self.assertTrue(safe_ops.disposable("a/b/x", ["a/b/"]))
        self.assertTrue(safe_ops.disposable(".pi/tasks/abc/x.output", safe_ops.DEFAULT_DISPOSABLE))
        self.assertFalse(safe_ops.disposable(".pi/tasks", safe_ops.DEFAULT_DISPOSABLE))


class CacheWorktreeBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="cache_litter_test_")))
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
        put(self.repo, ".gitignore", "*\n!README\n!.gitignore\n")  # every untracked path is ignored
        g(self.repo, "add", ".")
        g(self.repo, "commit", "-q", "-m", "init")
        self.wt = self.tmp / "repo.worktrees" / "feat"
        g(self.repo, "worktree", "add", "-q", "-b", "feat", str(self.wt))
        self.cfg = safe_ops.ops_config({})
        self.outside = self.tmp / "outside"
        put(self.outside, "keep.txt", "keep\n")

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


class CacheCleanedTest(CacheWorktreeBase):
    def test_each_listed_cache_is_cleaned(self):
        for entry in CACHES:
            for rel in (SAMPLES[entry], "pkg/sub/" + SAMPLES[entry]):
                with self.subTest(entry=entry, rel=rel):
                    try:
                        put(self.wt, rel)
                        self.assertEqual(self.check()["branch"], "feat")
                    finally:
                        self.wipe()

    def test_all_caches_together_are_cleaned(self):
        for entry in CACHES:
            put(self.wt, SAMPLES[entry])
        self.check()


class CacheRefusedTest(CacheWorktreeBase):
    def test_unlisted_file_is_refused_and_named_among_caches(self):
        for entry in CACHES:
            put(self.wt, SAMPLES[entry])
        put(self.wt, ".env.local")
        exc = self.refused()
        self.assertEqual(exc.files, [".env.local"])
        text = safe_ops.ignored_text(exc)
        self.assertEqual(text, "ignored_files (.env.local)")

    def test_near_misses_are_refused_and_named(self):
        for rel in (".coveragerc", "notes.tsbuildinfo.md", "x.egg-info.bak/a.txt", ".pytest_cache"):
            with self.subTest(rel=rel):
                put(self.wt, rel)
                self.assertEqual(self.refused().files, [rel])
                self.wipe()

    def test_symlink_named_like_a_cache_folder_is_refused_not_followed(self):
        try:
            os.symlink(str(self.outside), str(self.wt / ".pytest_cache"), target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks not available")
        exc = self.refused()
        self.assertEqual(exc.files, [".pytest_cache"])
        self.assertEqual((self.outside / "keep.txt").read_text(encoding="utf-8"), "keep\n")


class FileOnlyEntryTest(CacheWorktreeBase):
    def test_unit_level(self):
        d = safe_ops.DEFAULT_DISPOSABLE
        self.assertTrue(safe_ops.disposable("sub/.DS_Store", d))
        self.assertFalse(safe_ops.disposable(".DS_Store/notes.md", d))
        self.assertFalse(safe_ops.disposable(".DS_Store/", d))
        self.assertFalse(safe_ops.disposable("a.tsbuildinfo/work.txt", d))
        self.assertTrue(safe_ops.disposable("src/app.tsbuildinfo", d))
        self.assertFalse(safe_ops.disposable(".coverage.d/", d))

    def test_folder_named_like_a_file_entry_is_refused_and_names_the_file(self):
        for rel in (".coverage.d/notes.md", "a.tsbuildinfo/work.txt", ".DS_Store/notes.md", ".eslintcache/x.json"):
            with self.subTest(rel=rel):
                try:
                    put(self.wt, rel)
                    exc = self.refused()
                    self.assertEqual(exc.files, [rel])
                    self.assertIn(rel, safe_ops.ignored_text(exc))
                finally:
                    self.wipe()

    def test_user_entry_without_slash_does_not_cover_a_folder(self):
        put(self.wt, "node_modules/pkg/index.js")
        self.cfg = safe_ops.ops_config({"worktreeDisposable": ["node_modules"]})
        exc = self.refused()
        self.assertEqual(exc.files, ["node_modules/pkg/index.js"])
        self.assertIn("node_modules/pkg/index.js", safe_ops.ignored_text(exc))
        self.cfg = safe_ops.ops_config({"worktreeDisposable": ["node_modules/"]})
        self.assertEqual(self.check()["branch"], "feat")


class CacheSweepTest(CacheWorktreeBase):
    def sweep(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            fw.main(["sweep", "--cwd", str(self.repo), "--state", str(self.state), "--session", "s"])
        return out.getvalue().splitlines()

    def test_sweep_removes_a_cache_only_worktree(self):
        put(self.wt, ".pytest_cache/v/x")
        put(self.wt, ".mypy_cache/3.12/m.json")
        self.assertIn("removed: %s" % self.wt, self.sweep())
        self.assertFalse(self.wt.exists())

    def test_sweep_skips_a_worktree_with_an_unlisted_file(self):
        put(self.wt, ".pytest_cache/v/x")
        put(self.wt, ".env.local")
        self.assertIn("skipped: %s — ignored_files (.env.local)" % self.wt, self.sweep())
        self.assertTrue(self.wt.is_dir())


if __name__ == "__main__":
    unittest.main()
