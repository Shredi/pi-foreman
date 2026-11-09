"""git_guard child_submodule: the URL rule sees every spelling of a path and applies only to sync, init and update --init."""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import git_guard as gg  # noqa: E402
from _submodules import build_rig  # noqa: E402


@unittest.skipIf(os.name == "nt", "POSIX paths and symlinks")
class SubmodulePathSpellingTest(unittest.TestCase):
    def setUp(self):
        self.base = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.base, True)
        self.rig = build_rig(self.base)

    def decide(self, cmd, cwd=None):
        t = self.rig.tree
        return gg.decide(cmd, "child", cwd=cwd or t, env={"PI_FOREMAN_TREE_CEILING": t})

    def differ(self, name):
        path = os.path.join(self.rig.tree, ".gitmodules")
        text = Path(path).read_text()
        Path(path).write_text(text.replace("/src/%s" % name, "/elsewhere/%s" % name))

    def test_every_spelling_of_b_is_refused_when_the_url_differs(self):
        self.differ("b")
        t = self.rig.tree
        cases = [
            ("git submodule sync b", t),
            ("git submodule sync ./b", t),
            ("git submodule sync -- ./b", t),
            ("git submodule sync %s/b" % t, t),
            ("git submodule update --init ./b", t),
            ("git submodule sync ../b", os.path.join(t, "libs")),
        ]
        for cmd, cwd in cases:
            d = self.decide(cmd, cwd)
            self.assertEqual(d.level, 2, (cmd, cwd, d.reason))

    def test_every_spelling_is_allowed_when_the_url_matches(self):
        t = self.rig.tree
        cases = [
            ("git submodule sync ./b", t),
            ("git submodule sync -- ./b", t),
            ("git submodule sync %s/b" % t, t),
            ("git submodule update --init ./b", t),
            ("git submodule sync ../b", os.path.join(t, "libs")),
        ]
        for cmd, cwd in cases:
            d = self.decide(cmd, cwd)
            self.assertNotEqual(d.level, 2, (cmd, cwd, d.reason))

    def test_a_path_naming_a_parent_directory_covers_its_submodules(self):
        self.differ("a")
        for cmd in ("git submodule sync libs", "git submodule sync ./libs/", "git submodule sync ."):
            d = self.decide(cmd)
            self.assertEqual(d.level, 2, (cmd, d.reason))

    def test_a_path_that_misses_the_differing_submodule_passes(self):
        self.differ("a")
        self.assertNotEqual(self.decide("git submodule sync ./b").level, 2)


@unittest.skipIf(os.name == "nt", "POSIX paths and symlinks")
class SubmodulePathspecMagicTest(unittest.TestCase):
    """Globs and pathspec magic cover every submodule, so the URL rule checks them all."""

    CMDS = ("git submodule sync 'b*'", "git submodule sync ':/b'", "git submodule sync ':(top)b'", "git submodule update --init 'b*'")

    def setUp(self):
        self.base = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.base, True)
        self.rig = build_rig(self.base)

    def decide(self, cmd):
        t = self.rig.tree
        return gg.decide(cmd, "child", cwd=t, env={"PI_FOREMAN_TREE_CEILING": t})

    def test_pathspec_forms_are_refused_when_a_url_differs(self):
        path = os.path.join(self.rig.tree, ".gitmodules")
        Path(path).write_text(Path(path).read_text().replace("/src/b", "/elsewhere/b"))
        for cmd in self.CMDS:
            d = self.decide(cmd)
            self.assertEqual(d.level, 2, (cmd, d.reason))

    def test_pathspec_forms_are_allowed_when_every_url_matches(self):
        for cmd in self.CMDS:
            d = self.decide(cmd)
            self.assertNotEqual(d.level, 2, (cmd, d.reason))


@unittest.skipIf(os.name == "nt", "POSIX paths and symlinks")
class SubmoduleOptionValueTest(unittest.TestCase):
    """An option's separate value is not a path; an unknown option covers every submodule."""

    CMDS = (
        "git submodule update --init --depth 1",
        "git submodule update --init -j 2",
        "git submodule update --init --jobs 2",
        "git submodule update --init --filter blob:none",
        "git submodule update --init --reference ./r",
        "git submodule update --init --ref-format files",
        "git submodule update --init --depth=1",
        "git submodule update --init --jobs=2",
        "git submodule update --init -j2",
        "git submodule update --init --some-future-option x",
        "git submodule sync --depth 1",
    )

    def setUp(self):
        self.base = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.base, True)
        self.rig = build_rig(self.base)

    def decide(self, cmd):
        t = self.rig.tree
        return gg.decide(cmd, "child", cwd=t, env={"PI_FOREMAN_TREE_CEILING": t})

    def test_refused_when_a_url_differs(self):
        path = os.path.join(self.rig.tree, ".gitmodules")
        Path(path).write_text(Path(path).read_text().replace("/src/b", "/elsewhere/b"))
        for cmd in self.CMDS:
            d = self.decide(cmd)
            self.assertEqual(d.level, 2, (cmd, d.reason))

    def test_allowed_when_every_url_matches(self):
        for cmd in self.CMDS:
            if "future" in cmd:
                continue
            d = self.decide(cmd)
            self.assertNotEqual(d.level, 2, (cmd, d.reason))


@unittest.skipIf(os.name == "nt", "POSIX paths and symlinks")
class SubmoduleVerbScopeTest(unittest.TestCase):
    def setUp(self):
        self.base = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.base, True)
        self.rig = build_rig(self.base)
        path = os.path.join(self.rig.tree, ".gitmodules")
        Path(path).write_text(Path(path).read_text().replace("/src/b", "/elsewhere/b"))

    def decide(self, cmd):
        t = self.rig.tree
        return gg.decide(cmd, "child", cwd=t, env={"PI_FOREMAN_TREE_CEILING": t})

    def test_status_foreach_and_plain_update_do_not_check_urls(self):
        for cmd in ("git submodule status", "git submodule foreach 'git status'", "git submodule update", "git submodule update ./b"):
            d = self.decide(cmd)
            self.assertNotEqual(d.level, 2, (cmd, d.reason))

    def test_sync_init_and_update_init_do_check_urls(self):
        for cmd in ("git submodule sync", "git submodule init", "git submodule update --init"):
            self.assertEqual(self.decide(cmd).level, 2, cmd)

    def test_the_inside_the_tree_rule_still_applies_to_every_verb(self):
        outside = self.rig.superproject
        for cmd in ("git submodule status %s" % outside, "git submodule update %s" % outside):
            self.assertEqual(self.decide(cmd).level, 2, cmd)


if __name__ == "__main__":
    unittest.main()
