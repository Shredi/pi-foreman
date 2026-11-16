"""scripts/foreman_radar.py passes the PR tracker's `hiddenRepo: true` mark through from open-prs.json and tracked-prs-state.json (no matching here)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "scripts"))

from test_foreman_radar import Fixture  # noqa: E402
import test_foreman_radar_open_prs as base  # noqa: E402

GOOD, tracked = base.GOOD, base.tracked


class HiddenRepoTests(Fixture):
    enable, put_cache, doc = base.OpenPrsTests.enable, base.OpenPrsTests.put_cache, base.OpenPrsTests.doc
    put_state, put_search = base.TrackedPrsTests.put_state, base.TrackedPrsTests.put_search

    def test_search_entry_mark_passes_through_only_when_true(self):
        self.enable()
        self.put_search([dict(GOOD, number=1, url="https://example.test/acme/widgets/pull/1", hiddenRepo=True),
                         dict(GOOD, number=2, url="https://example.test/acme/widgets/pull/2", hiddenRepo="yes"),
                         dict(GOOD, number=3, url="https://example.test/acme/widgets/pull/3", hiddenRepo=1),
                         dict(GOOD, number=4, url="https://example.test/acme/widgets/pull/4")])
        got = {p["number"]: p for p in self.doc()["openPrs"]}
        self.assertIs(got[1]["hiddenRepo"], True)
        for n in (2, 3, 4):
            self.assertNotIn("hiddenRepo", got[n])

    def test_tracked_only_entry_mark_passes_through(self):
        self.enable()
        self.put_state([tracked(number=1, hiddenRepo=True), tracked(number=2, hiddenRepo="x"), tracked(number=3)])
        got = {p["number"]: p for p in self.doc()["openPrs"]}
        self.assertIs(got[1]["hiddenRepo"], True)
        self.assertNotIn("hiddenRepo", got[2])
        self.assertNotIn("hiddenRepo", got[3])

    def test_twin_is_hidden_when_either_side_is_marked(self):
        self.enable()
        for search_mark, tracked_mark in ((True, False), (False, True), (True, True), (False, False)):
            self.put_search([dict(GOOD, **({"hiddenRepo": True} if search_mark else {}))])
            self.put_state([tracked(**({"hiddenRepo": True} if tracked_mark else {}))])
            (p,) = self.doc()["openPrs"]
            self.assertEqual(p.get("hiddenRepo"), True if (search_mark or tracked_mark) else None, (search_mark, tracked_mark))
            self.assertNotIn("tracked", p)


if __name__ == "__main__":
    unittest.main()
