"""scripts/foreman_radar.py --json: `trackedAt` (tracked-prs-state.json, ISO, null when missing) and `trackedN` (lines of tracked-prs.json) next to the open PRs."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "scripts"))

import foreman_radar as fr  # noqa: E402
from test_foreman_radar import Fixture  # noqa: E402
from test_foreman_radar_open_prs import GOOD, NOW_MS, TrackedPrsTests  # noqa: E402


class TrackedAtTests(Fixture):
    enable, put_cache, doc, put_state, put_search = (TrackedPrsTests.enable, TrackedPrsTests.put_cache, TrackedPrsTests.doc,
                                                     TrackedPrsTests.put_state, TrackedPrsTests.put_search)

    def put_list(self, n):
        p = self.base / "state" / "tracked-prs.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"v": 1, "prs": [{"repo": "o/r", "number": i + 1, "addedAt": 1} for i in range(n)]}), "utf-8")

    def test_fields_from_the_state_and_the_list(self):
        self.enable()
        self.put_search([GOOD])
        self.put_state([], trackedAt=NOW_MS - 120_000)
        self.put_list(2)
        d = self.doc()
        self.assertEqual(d["trackedN"], 2)
        self.assertLess(abs(fr.parse_ts(d["trackedAt"]) * 1000 - (NOW_MS - 120_000)), 1000)
        self.assertRegex(d["trackedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

    def test_missing_state_is_null_and_no_list_is_zero(self):
        self.enable()
        self.put_search([GOOD])
        d = self.doc()
        self.assertIsNone(d["trackedAt"])
        self.assertEqual(d["trackedN"], 0)


if __name__ == "__main__":
    unittest.main()
