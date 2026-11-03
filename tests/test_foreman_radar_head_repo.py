"""scripts/foreman_radar.py --json: the feed's `headRepo` (the repository of the PR head, differs from `repo` for a fork PR)
reaches `openPrs` only when it is a non-empty string."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from test_foreman_radar_session_pr_join import PR, SessionPrJoinTests  # noqa: E402


class HeadRepoTests(SessionPrJoinTests):
    def test_head_repo_of_a_feed_pr_passes_through_only_when_valid(self):
        p = self.base / "state" / "open-prs.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        odd = dict(PR, number=8, url="https://example.test/acme/widgets/pull/8", headRepo=3)
        p.write_text(json.dumps({"v": 1, "fetchedAt": "2026-10-31T10:00:00Z",
                                 "openPrs": [dict(PR, headRepo="fork/widgets"), odd, dict(PR, number=9, url="https://example.test/acme/widgets/pull/9")]}), "utf-8")
        got = {x["number"]: x for x in self.doc()["openPrs"]}
        self.assertEqual(got[7]["headRepo"], "fork/widgets")
        self.assertNotIn("headRepo", got[8])
        self.assertNotIn("headRepo", got[9])


del SessionPrJoinTests

if __name__ == "__main__":
    unittest.main()
