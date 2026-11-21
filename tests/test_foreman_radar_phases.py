"""scripts/foreman_radar.py passes the PR tracker's phase result (`phase` per check, `gate`, `gated`, `ruled` per entry) through for tracked and search-feed PRs; nothing is classified here."""
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


class PhaseTests(Fixture):
    enable, put_cache, doc = base.OpenPrsTests.enable, base.OpenPrsTests.put_cache, base.OpenPrsTests.doc
    put_state, put_search = base.TrackedPrsTests.put_state, base.TrackedPrsTests.put_search

    def test_tracked_entry_passes_phase_gate_gated_ruled(self):
        self.enable()
        e = tracked()
        e["snap"]["runs"] = [{"id": "1", "name": "ci", "bucket": "passed", "url": ""},
                             {"id": "2", "name": "ci/gate", "bucket": "failed", "url": "", "phase": 2},
                             {"id": "3", "name": "review-assign", "bucket": "failed", "url": "", "phase": "ignore"},
                             {"id": "4", "name": "x", "bucket": "passed", "url": "", "phase": 1}]
        e["snap"].update(gate={"state": "failed", "waiting": ["a"]}, gated=True, ruled=True)
        self.put_state([e])
        (p,) = self.doc()["openPrs"]
        self.assertEqual([c.get("phase") for c in p["checks"]], [None, 2, "ignore", None])
        self.assertEqual(p["gate"], {"state": "failed", "waiting": ["a"]})
        self.assertIs(p["gated"], True)
        self.assertIs(p["ruled"], True)

    def test_tracked_entry_drops_bad_values(self):
        self.enable()
        e = tracked()
        e["snap"]["runs"][0]["phase"] = "gate"
        e["snap"].update(gate={"state": "bogus"}, gated="yes", ruled=1)
        self.put_state([e])
        (p,) = self.doc()["openPrs"]
        self.assertNotIn("phase", p["checks"][0])
        for k in ("gate", "gated", "ruled"):
            self.assertNotIn(k, p)

    def test_search_entry_passes_phase_gate_gated_ruled(self):
        self.enable()
        self.put_search([dict(GOOD, checks=[{"n": "ci", "state": "ok", "label": "ci"}, {"n": "ci/gate", "state": "run", "label": "g", "phase": 2},
                                            {"n": "r", "state": "fail", "label": "r", "phase": "ignore"}],
                              gate={"state": "running"}, gated=True, ruled=True),
                         dict(GOOD, number=9, url="https://example.test/acme/widgets/pull/9", gate={"state": "x"}, gated=False)])
        got = {p["number"]: p for p in self.doc()["openPrs"]}
        a = got[GOOD["number"]]
        self.assertEqual([c.get("phase") for c in a["checks"]], [None, 2, "ignore"])
        self.assertEqual((a["gate"], a["gated"], a["ruled"]), ({"state": "running"}, True, True))
        for k in ("gate", "gated", "ruled"):
            self.assertNotIn(k, got[9])


if __name__ == "__main__":
    unittest.main()
