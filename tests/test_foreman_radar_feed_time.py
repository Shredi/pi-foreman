"""scripts/foreman_radar.py --json: a tracked entry replaces its search twin when display-fresh or when its time (okAt, else the state `at` of an
entry without `error`) is not older than the search file's fetchedAt; a tracked entry's `waiting` list reaches the feed entry, validated."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "scripts"))

from test_foreman_radar import Fixture  # noqa: E402
from test_foreman_radar_open_prs import GOOD, NOW_MS, SEARCH_AT, TrackedPrsTests, tracked  # noqa: E402
import foreman_radar as fr  # noqa: E402

FETCHED_MS = int(fr.parse_ts(SEARCH_AT) * 1000)
TWIN = dict(GOOD, repo="Acme/Widgets", author="octo", url="https://github.com/Acme/Widgets/pull/7")


class FeedTimeTests(Fixture):
    enable, put_cache, doc, put_state, put_search = (TrackedPrsTests.enable, TrackedPrsTests.put_cache, TrackedPrsTests.doc,
                                                     TrackedPrsTests.put_state, TrackedPrsTests.put_search)

    def entry(self, **over):
        e = tracked(**over)
        e.pop("okAt", None)
        return e

    def winner(self):
        (p,) = self.doc()["openPrs"]
        return p["title"]

    def test_no_okAt_no_error_and_at_newer_than_the_search_fetch_replaces_the_twin(self):
        self.put_search([TWIN])
        self.put_state([self.entry(at=FETCHED_MS + 60_000)])
        self.assertEqual(self.winner(), "T7")
        (p,) = self.doc()["openPrs"]
        self.assertEqual(p["author"], "octo", "the twin's author is kept")

    def test_okAt_stale_but_not_older_than_the_fetch_replaces_the_twin(self):
        self.put_search([TWIN])
        self.put_state([tracked(ok_ms=FETCHED_MS + 1_000)])  # more than 15 min before `now`, but newer than the search file
        self.assertEqual(self.winner(), "T7")

    def test_older_than_the_fetch_and_stale_keeps_the_search_entry(self):
        self.put_search([TWIN])
        self.put_state([self.entry(at=FETCHED_MS - 60_000)])
        self.assertEqual(self.winner(), "Tune")
        self.put_state([tracked(ok_ms=NOW_MS - 16 * 60_000, at=FETCHED_MS + 60_000)])  # okAt decides when present
        self.assertEqual(self.winner(), "Tune")

    def test_errored_entry_without_okAt_has_no_time(self):
        self.put_search([TWIN])
        self.put_state([self.entry(at=FETCHED_MS + 60_000, error="boom", errorAt=FETCHED_MS + 60_000)])
        self.assertEqual(self.winner(), "Tune")

    def test_waiting_names_are_passed_through_validated(self):
        self.put_state([tracked(waiting=["gate", "x" * 300]), tracked(number=8, waiting=["a", 3]), tracked(number=9, waiting="gate"),
                        tracked(number=10, waiting=[]), tracked(number=11, waiting=["n%d" % i for i in range(30)])])
        got = {p["number"]: p for p in self.doc()["openPrs"]}
        self.assertEqual(got[7]["waiting"], ["gate", "x" * 120])
        for n in (8, 9, 10):
            self.assertNotIn("waiting", got[n])
        self.assertEqual(len(got[11]["waiting"]), 10)


# the imported class only lends its helpers: its own tests run from their module
del TrackedPrsTests

if __name__ == "__main__":
    unittest.main()
