"""A watched PR whose head moved past the last reviewer PASS: radar copies `waits[].unreviewed`, the sidebar's `pr #n` item names it."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "scripts"))
sys.path.insert(0, str(HERE.parent / "integrations" / "herdr" / "pi-foreman-sidebar"))

from test_foreman_radar import Fixture, live  # noqa: E402
from test_foreman_radar import NOW  # noqa: E402
from test_herdr_sidebar import B, tnode  # noqa: E402
import foreman_radar as fr  # noqa: E402
import sidebar  # noqa: E402
import contextlib  # noqa: E402
import io  # noqa: E402
from unittest import mock  # noqa: E402


def wait(**extra):
    return dict({"id": "pr_watch", "kind": "pr", "note": "2 pr watch", "ageSeconds": 0, "leftSeconds": 0, "prs": [12, 14]}, **extra)


class RadarCopy(Fixture):
    def waits_of(self, waits):
        top = live("s-u", "u", "fm-u", hb=0)
        top["waits"] = waits
        self.put_live(top)
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(fr.time, "time", return_value=NOW):
            self.assertEqual(fr.main(["--agent-dir", str(self.adir), "--json"]), 0)
        (root,) = json.loads(out.getvalue())["roots"]
        return root["waits"]

    def test_unreviewed_is_copied_only_when_present_and_well_formed(self):
        mark = {"n": 12, "repo": "acme/app", "host": "example.test"}
        got = self.waits_of([wait(unreviewed=[mark, {"n": "x"}, {"n": True}, "junk"]), wait(unreviewed=[]), wait()])
        self.assertEqual(got[0]["unreviewed"], [mark])
        self.assertNotIn("unreviewed", got[1])
        self.assertNotIn("unreviewed", got[2])


class SidebarItem(unittest.TestCase):
    def line(self, **extra):
        w = {"id": "pr_watch", "kind": "pr", "note": "2 pr watch", "age_s": 0, "left_s": 0, "prs": [12, 14]}
        w.update(extra)
        n = tnode("s", "sess", "⠼", waits=[w])
        out = sidebar.compose({"symbols": "unicode", "recentRunSeconds": 8, "roots": [n]}, 60)["P-s"]
        return out["fm_a2"].replace(B, " ").strip()

    def test_flagged_pr_names_the_token_and_the_other_does_not(self):
        self.assertEqual(self.line(unreviewed=[{"n": 12, "repo": "", "host": ""}]), "⚙ pr #12 unreviewed head · pr #14")

    def test_followed_only_and_cleared_stay_plain(self):
        self.assertEqual(self.line(), "⚙ pr #12 · pr #14")
        self.assertEqual(self.line(unreviewed=[]), "⚙ pr #12 · pr #14")


if __name__ == "__main__":
    unittest.main()
