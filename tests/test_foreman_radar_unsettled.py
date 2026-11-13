"""scripts/foreman_radar.py --json: a tracked entry's `unsettled` flag (set by `foreman prs poll` while a pass is held) reaches the feed entry."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "scripts"))

from test_foreman_radar import Fixture  # noqa: E402
from test_foreman_radar_open_prs import TrackedPrsTests, tracked  # noqa: E402

PASSED = [{"id": "1", "name": "ci", "bucket": "passed", "url": ""}]


class UnsettledTests(Fixture):
    enable, put_cache, doc, put_state = TrackedPrsTests.enable, TrackedPrsTests.put_cache, TrackedPrsTests.doc, TrackedPrsTests.put_state

    def entry(self, **over):
        e = tracked(**over)
        e["snap"]["runs"] = PASSED
        return e

    def test_flag_is_passed_through(self):
        self.put_state([self.entry(unsettled=True)])
        (p,) = self.doc()["openPrs"]
        self.assertIs(p["unsettled"], True)
        self.assertEqual(p["checks"], [{"n": "ci", "state": "ok", "label": "ci"}])

    def test_no_flag_without_it_or_with_another_value(self):
        self.put_state([self.entry(), self.entry(number=8, unsettled="yes")])
        for p in self.doc()["openPrs"]:
            self.assertNotIn("unsettled", p)


# the imported class only lends its helpers: its own tests run from their module
del TrackedPrsTests

if __name__ == "__main__":
    unittest.main()
