"""foreman_radar: the PR feed joins tracked and searched entries by (host, repo, number)."""
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "scripts"))

from test_foreman_radar import Fixture  # noqa: E402
from test_foreman_radar_open_prs import GOOD, NOW_MS, SEARCH_AT, OpenPrsTests, tracked  # noqa: E402

GHE = "ghe.example.test"
GHE_URL = "https://%s/acme/widgets/pull/7" % GHE


class HostJoinTests(Fixture):
    enable, put_cache, doc = OpenPrsTests.enable, OpenPrsTests.put_cache, OpenPrsTests.doc

    def put_search(self, entries):
        self.put_cache({"v": 1, "fetchedAt": SEARCH_AT, "openPrs": entries})

    def put_keyed(self, pairs):
        import json
        p = self.base / "state" / "tracked-prs-state.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"v": 1, "trackedAt": NOW_MS, "prs": dict(pairs)}), "utf-8")

    def test_a_ghe_tracked_pr_and_a_github_search_pr_with_the_same_number_both_show(self):
        self.put_search([dict(GOOD, url="https://github.com/acme/widgets/pull/7")])
        self.put_keyed([("%s/acme/widgets#7" % GHE, tracked(url=GHE_URL))])
        got = self.doc()["openPrs"]
        self.assertEqual(sorted(p["url"] for p in got), sorted([GHE_URL, "https://github.com/acme/widgets/pull/7"]))
        by_url = {p["url"]: p for p in got}
        self.assertEqual(by_url[GHE_URL]["host"], GHE)
        self.assertTrue(by_url[GHE_URL]["tracked"])
        self.assertNotIn("tracked", by_url["https://github.com/acme/widgets/pull/7"])

    def test_a_ghe_search_entry_is_replaced_by_its_ghe_tracked_twin_only(self):
        self.put_search([dict(GOOD, url=GHE_URL, host=GHE.upper(), author="octo"),
                         dict(GOOD, url="https://github.com/acme/widgets/pull/7", author="gh-octo")])
        self.put_keyed([("%s/acme/widgets#7" % GHE, tracked(url=GHE_URL))])
        got = {p["url"]: p for p in self.doc()["openPrs"]}
        self.assertEqual(len(got), 2)
        self.assertEqual((got[GHE_URL]["title"], got[GHE_URL]["author"], got[GHE_URL]["host"]), ("T7", "octo", GHE))
        self.assertEqual(got["https://github.com/acme/widgets/pull/7"]["title"], "Tune")

    def test_search_host_is_validated_and_a_bad_one_reads_as_github(self):
        self.put_search([dict(GOOD, host="bad host"), dict(GOOD, number=8, host=5)])
        got = self.doc()["openPrs"]
        self.assertTrue(all("host" not in p for p in got))
        self.put_search([dict(GOOD, host="bad host")])
        self.put_keyed([("acme/widgets#7", tracked(url="https://github.com/acme/widgets/pull/7"))])
        (p,) = self.doc()["openPrs"]
        self.assertEqual(p["title"], "T7")

    def test_a_key_without_a_prefix_is_github(self):
        self.put_search([dict(GOOD, url="https://github.com/acme/widgets/pull/7")])
        self.put_keyed([("acme/widgets#7", tracked())])
        (p,) = self.doc()["openPrs"]
        self.assertEqual(p["title"], "T7")
        self.assertNotIn("host", p)


if __name__ == "__main__":
    unittest.main()
