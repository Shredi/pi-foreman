"""The owner's presence (live state `owner`): the radar JSON carries it and the Herdr sidebar's cost row shows ` · owner <state>`."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "integrations" / "herdr" / "pi-foreman-sidebar"
sys.path.insert(0, str(PLUGIN))
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import _isolation  # noqa: E402,F401
import foreman_radar as fr  # noqa: E402
import sidebar  # noqa: E402
from test_foreman_radar import NOW, Fixture, live  # noqa: E402
from test_herdr_sidebar import snapshot  # noqa: E402


class RadarOwner(Fixture):
    def doc(self):
        return fr.json_doc(self.snap(), NOW, "unicode", fr.load_symbols("unicode"))

    def test_owner_is_carried_only_for_the_four_states(self):
        d = live("s1", "a", "fm-a")
        self.put_live(d)
        self.assertNotIn("owner", self.doc()["roots"][0])
        for state in ("present", "away", "grace", "unknown"):
            with self.subTest(state=state):
                d["owner"] = state
                self.put_live(d)
                self.assertEqual(self.doc()["roots"][0]["owner"], state)
        for bad in ("here", "", 3, None, True):
            with self.subTest(bad=bad):
                d["owner"] = bad
                self.put_live(d)
                self.assertNotIn("owner", self.doc()["roots"][0])

    def test_owner_does_not_change_presence_or_away(self):
        d = live("s1", "a", "fm-a")
        d["away"] = True
        d["owner"] = "grace"
        self.put_live(d)
        root = self.doc()["roots"][0]
        self.assertIs(root["away"], True)
        self.assertEqual(root["owner"], "grace")


class SidebarOwner(unittest.TestCase):
    def cost_row(self, owner, away=None, width=40):
        snap = snapshot()
        if owner is not None:
            snap["roots"][0]["owner"] = owner
        if away is not None:
            snap["roots"][0]["away"] = away
        return sidebar.compose(snap, width)["w1:p1"]["fm_meta"]

    def test_each_state_is_named(self):
        for state in ("present", "away", "grace", "unknown"):
            with self.subTest(state=state):
                self.assertIn("$0.47 · owner " + state, self.cost_row(state))

    def test_absent_or_invalid_owner_shows_nothing(self):
        base = self.cost_row(None)
        self.assertNotIn("owner", base)
        for bad in ("here", "", 3, True):
            with self.subTest(bad=bad):
                self.assertEqual(self.cost_row(bad), base)

    def test_owner_replaces_the_legacy_away_suffix(self):
        row = self.cost_row("away", away=True)
        self.assertIn("owner away", row)
        self.assertEqual(row.count("away"), 1)
        self.assertIn("$0.47 · away", self.cost_row(None, away=True), "files without owner keep the legacy suffix")

    def test_row_fits_the_width(self):
        for width in (20, 24, 34, 40):
            for state in ("present", "away", "grace", "unknown"):
                with self.subTest(width=width, state=state):
                    self.assertLessEqual(sidebar.cell_width(self.cost_row(state, width=width)), width - sidebar.INSET)


if __name__ == "__main__":
    unittest.main()
