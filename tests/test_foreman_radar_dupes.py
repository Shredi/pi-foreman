"""D83 (a): one PR must not show twice in the radar feed when the tracked key and the search entry spell the host or repo differently,
and a search that is off leaves only the tracked PRs."""
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "scripts"))

from test_foreman_radar import Fixture  # noqa: E402
from test_foreman_radar_open_prs import GOOD, NOW_MS, SEARCH_AT, OpenPrsTests, tracked  # noqa: E402

GHE = "ghe.example.test"


class DuplicateTests(Fixture):
    enable, put_cache, doc = OpenPrsTests.enable, OpenPrsTests.put_cache, OpenPrsTests.doc

    def put_search(self, entries):
        self.put_cache({"v": 1, "fetchedAt": SEARCH_AT, "openPrs": entries})

    def put_keyed(self, pairs):
        p = self.base / "state" / "tracked-prs-state.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"v": 1, "trackedAt": NOW_MS, "prs": dict(pairs)}), "utf-8")

    def twin(self, search_host, key_host, url_host=None):
        url = "https://%s/acme/widgets/pull/7" % (url_host or key_host)
        self.put_search([dict(GOOD, url=url, host=search_host)])
        self.put_keyed([("%s/acme/widgets#7" % key_host, tracked(url=url))])
        return self.doc()["openPrs"]

    # M1: host spelling
    def test_ghe_host_with_a_port_on_both_sides_is_one_entry(self):
        got = self.twin(GHE + ":8443", GHE + ":8443")
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["title"], "T7")  # the tracked entry replaced its twin
        self.assertNotIn("tracked", got[0])

    def test_ghe_host_in_another_case_is_one_entry(self):
        self.assertEqual(len(self.twin(GHE.upper(), GHE)), 1)

    def test_default_port_spelled_on_one_side_is_one_entry(self):
        got = self.twin(GHE + ":443", GHE, url_host=GHE)
        self.assertEqual(len(got), 1, got)

    def test_default_port_spelled_on_the_tracked_side_is_one_entry(self):
        got = self.twin(GHE, GHE + ":443")
        self.assertEqual(len(got), 1, got)

    def test_a_different_non_default_port_stays_two_hosts(self):
        self.assertEqual(len(self.twin(GHE + ":8443", GHE + ":9443")), 2)

    # M2: the tracked key carries another repository than the PR's URL (a fork checkout's fallback key)
    def test_tracked_key_of_a_fork_with_the_base_url_joins_the_search_twin(self):
        url = "https://github.com/acme/widgets/pull/7"
        self.put_search([dict(GOOD, url=url)])
        self.put_keyed([("fork/widgets#7", tracked(repo="fork/widgets", url=url))])
        got = self.doc()["openPrs"]
        self.assertEqual([(p["repo"], p["number"]) for p in got], [("acme/widgets", 7)])

    def test_tracked_key_of_a_fork_alone_is_listed_under_the_url_repository(self):
        url = "https://github.com/acme/widgets/pull/7"
        self.put_keyed([("fork/widgets#7", tracked(repo="fork/widgets", url=url))])
        got = self.doc()["openPrs"]
        self.assertEqual([(p["repo"], p["number"]) for p in got], [("acme/widgets", 7)])
        self.assertTrue(got[0]["tracked"])

    # D98: the search is off, the poll cleared the file
    def test_a_cleared_search_file_leaves_only_tracked_entries(self):
        self.put_cache({"v": 1, "checkedAt": SEARCH_AT, "openPrs": []})
        self.put_keyed([("acme/widgets#7", tracked())])
        d = self.doc()
        self.assertEqual([(p["number"], p.get("tracked")) for p in d["openPrs"]], [(7, True)])
        self.assertNotIn("openPrsAt", d)


if __name__ == "__main__":
    unittest.main()
