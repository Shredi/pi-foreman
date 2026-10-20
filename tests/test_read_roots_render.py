"""safety.permissions.readRoots: each root lands in external_directory_read (dir and dir/*, plus the realpath spelling); read only."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import permissions_gen as pg  # noqa: E402

OWNED = {"scratchRoot": "/tmpx/pi-foreman-scratch", "npmRoot": "/opt/npm/lib/node_modules"}


class ReadRootsRender(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.agent = Path(self.tmp.name) / "agent"
        self.agent.mkdir()

    def mk(self, rel):
        d = Path(os.path.realpath(self.tmp.name)) / rel
        d.mkdir(parents=True, exist_ok=True)
        return d.as_posix()

    def render(self, roots):
        return pg.render({"readRoots": roots}, self.agent, owned=OWNED)["permission"]

    def test_default_adds_nothing(self):
        p = pg.render({}, self.agent, owned=OWNED)["permission"]
        self.assertNotIn("/repos/*", p["external_directory_read"])

    def test_root_renders_dir_and_subtree_read_only(self):
        repos = self.mk("repos")
        p = self.render([repos])
        self.assertEqual(p["external_directory_read"][repos], "allow")
        self.assertEqual(p["external_directory_read"][repos + "/*"], "allow")
        self.assertNotIn(repos + "/*", p["external_directory"])

    def test_unsafe_entries_are_dropped(self):
        p = self.render(["rel/dir", "/a/../b", "", 3, "/", "~"])
        self.assertEqual([k for k in p["external_directory_read"] if k in ("/", "/*", "rel/dir", "/a/../b")], [])
        home = Path.home().as_posix()
        self.assertNotIn(home, p["external_directory_read"])

    def test_tilde_is_the_home_dir(self):
        home = self.mk("u")
        self.mk("u/repos")
        self.assertEqual(pg.read_roots_patterns(["~/repos"], home=home)[:2], [home + "/repos", home + "/repos/*"])

    def test_home_and_its_ancestors_are_dropped(self):
        self.assertEqual(pg.read_roots_patterns(["/home/u", "/home", "~"], home="/home/u"), [])

    def test_glob_entries_are_dropped(self):
        self.mk("globroot")
        base = Path(os.path.realpath(self.tmp.name)).as_posix()
        self.assertEqual(pg.read_roots_patterns(["/*", "/U*", base + "/glob*", base + "/globro?t", base + "/[g]lobroot"], home="/nonexistent-home"), [])

    def test_unresolved_entry_is_dropped(self):
        base = Path(os.path.realpath(self.tmp.name)).as_posix()
        self.assertEqual(pg.read_roots_patterns([base + "/nonexistent"], home="/nonexistent-home"), [])

    def test_home_ancestor_case_variant_is_dropped_when_folding(self):
        home = self.mk("Users/u")
        upper = self.mk("USERS")
        for platform in ("darwin", "win32"):
            self.assertEqual(pg.read_roots_patterns([upper], home=home, platform=platform), [], platform)
        self.assertEqual(pg.read_roots_patterns([home.rsplit("/", 1)[0].upper()], home=home, platform="darwin"), [])

    def test_symlinked_root_renders_the_realpath_spelling_too(self):
        real = Path(self.tmp.name).resolve() / "realroot"
        real.mkdir()
        link = Path(self.tmp.name).resolve() / "linkroot"
        os.symlink(real, link)
        got = pg.read_roots_patterns([str(link)], home="/nonexistent-home")
        self.assertEqual(got, [link.as_posix(), link.as_posix() + "/*", real.as_posix(), real.as_posix() + "/*"])


if __name__ == "__main__":
    unittest.main()
