"""R10 item 3: the toolchain probe dirs of the baseline (`externalDirectory.probe`) render as external_directory_read keys only:
each dir and dir/*, a leading ~ as the home dir, %APPDATA% only on Windows, an unresolved entry dropped."""
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import permissions_gen as pg  # noqa: E402

PROBE = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "~/.local/bin", "~/.npm/_npx", "~/.npm-global/bin", "%APPDATA%/npm"]


class ProbeRenderTest(unittest.TestCase):
    def test_posix_dirs_and_subtrees_with_home(self):
        out = pg.probe_read_patterns(PROBE, home="/h/u", platform="linux", env={"APPDATA": "C:/Users/u/AppData/Roaming"})
        self.assertEqual(out, ["/usr/local/bin", "/usr/local/bin/*", "/opt/homebrew/bin", "/opt/homebrew/bin/*", "/usr/bin", "/usr/bin/*",
                               "/h/u/.local/bin", "/h/u/.local/bin/*", "/h/u/.npm/_npx", "/h/u/.npm/_npx/*",
                               "/h/u/.npm-global/bin", "/h/u/.npm-global/bin/*"])

    def test_appdata_only_on_windows(self):
        out = pg.probe_read_patterns(["%APPDATA%/npm"], home="C:/Users/u", platform="win32", env={"APPDATA": "C:\\Users\\u\\AppData\\Roaming"})
        self.assertEqual(out, ["C:/Users/u/AppData/Roaming/npm", "C:/Users/u/AppData/Roaming/npm/*"])
        self.assertEqual(pg.probe_read_patterns(["%APPDATA%/npm"], home="/h", platform="darwin", env={"APPDATA": "C:/x"}), [])

    def test_unresolved_entries_are_dropped(self):
        self.assertEqual(pg.probe_read_patterns(["%APPDATA%/npm"], home="C:/Users/u", platform="win32", env={}), [])
        self.assertEqual(pg.probe_read_patterns(["~/.local/bin"], home="", platform="linux", env={}), [])
        self.assertEqual(pg.probe_read_patterns(["rel/bin", "{token}/bin", ""], home="/h", platform="linux", env={}), [])

    def test_render_puts_them_in_the_read_map_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent = Path(tmp) / "agent"
            agent.mkdir()
            perm = pg.render({}, agent, owned={"scratchRoot": "/tmpx/pi-foreman-scratch", "npmRoot": None})["permission"]
        read, bare = perm["external_directory_read"], perm["external_directory"]
        for key in ("/usr/local/bin", "/usr/local/bin/*", "/usr/bin/*", Path.home().as_posix() + "/.npm/_npx/*"):
            self.assertEqual(read.get(key), "allow", key)
            self.assertNotIn(key, bare)
        self.assertEqual(bare["*"], "ask")

    def test_baseline_carries_the_fixed_list(self):
        self.assertEqual(pg.load_baseline()["externalDirectory"]["probe"], PROBE)


if __name__ == "__main__":
    unittest.main()
