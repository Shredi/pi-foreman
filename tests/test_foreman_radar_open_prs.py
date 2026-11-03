"""scripts/foreman_radar.py --json: `openPrs` and `openPrsAt` come from state/open-prs.json (no network), only when radar.openPrs.enabled."""
from __future__ import annotations

import contextlib
import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "scripts"))

from test_foreman_radar import NOW, Fixture  # noqa: E402
import foreman_radar as fr  # noqa: E402

GOOD = {"repo": "acme/widgets", "number": 7, "title": "Tune", "url": "https://example.test/acme/widgets/pull/7",
        "state": "open", "author": "octo", "checks": [{"n": "ci", "state": "ok", "label": "ci"}]}


class OpenPrsTests(Fixture):
    def enable(self, on=True):
        (self.adir / "foreman.json").parent.mkdir(parents=True, exist_ok=True)
        (self.adir / "foreman.json").write_text(json.dumps({"radar": {"openPrs": {"enabled": on}}}), "utf-8")

    def put_cache(self, doc):
        p = self.base / "state" / "open-prs.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(doc), "utf-8")

    def doc(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(fr.time, "time", return_value=NOW), \
                mock.patch("subprocess.run", side_effect=AssertionError("no process")), \
                mock.patch("socket.socket", side_effect=AssertionError("no network")):
            self.assertEqual(fr.main(["--agent-dir", str(self.adir), "--json"]), 0)
        return json.loads(out.getvalue())

    def test_entries_and_time_are_emitted(self):
        self.enable()
        self.put_cache({"v": 1, "fetchedAt": "2026-10-31T10:00:00Z", "checkedAt": "2026-10-31T10:00:00Z", "openPrs": [GOOD]})
        d = self.doc()
        self.assertEqual(d["openPrs"], [GOOD])
        self.assertEqual(d["openPrsAt"], "2026-10-31T10:00:00Z")

    def test_malformed_entries_are_dropped(self):
        self.enable()
        bad = [
            dict(GOOD, url="http://example.test/a/b/pull/1"),
            dict(GOOD, url="https://example.test/a b"),
            dict(GOOD, number="7"),
            dict(GOOD, number=True),
            dict(GOOD, repo=""),
            dict(GOOD, title=5),
            "x", None,
        ]
        odd = dict(GOOD, number=8, url="https://example.test/acme/widgets/pull/8", state="weird",
                   checks=[{"n": "a", "state": "bogus", "label": "a"}, {"n": "b", "state": "fail", "label": "b"}, 3])
        self.put_cache({"v": 1, "fetchedAt": "2026-10-31T10:00:00Z", "openPrs": bad + [GOOD, odd]})
        got = self.doc()["openPrs"]
        self.assertEqual([p["number"] for p in got], [7, 8])
        self.assertEqual(got[1]["state"], "open")
        self.assertEqual(got[1]["checks"], [{"n": "b", "state": "fail", "label": "b"}])

    def test_absent_unreadable_or_disabled_gives_no_field(self):
        self.enable()
        self.assertNotIn("openPrs", self.doc())
        self.put_cache({"v": 1, "openPrs": [GOOD]})  # no fetch time
        self.assertNotIn("openPrs", self.doc())
        p = self.base / "state" / "open-prs.json"
        p.write_text("{nope", "utf-8")
        self.assertNotIn("openPrs", self.doc())
        self.put_cache({"v": 1, "fetchedAt": "2026-10-31T10:00:00Z", "openPrs": [GOOD]})
        self.enable(False)
        d = self.doc()
        self.assertNotIn("openPrs", d)
        self.assertNotIn("openPrsAt", d)

    def test_default_config_is_on(self):
        self.put_cache({"v": 1, "fetchedAt": "2026-10-31T10:00:00Z", "openPrs": [GOOD]})
        self.assertEqual(self.doc()["openPrs"], [GOOD])

    def test_branch_description_and_mergeable_pass_through_only_when_valid(self):
        full = dict(GOOD, headRefName="feat/x", bodyText="Fixes the flaky wait.", mergeable="CONFLICTING")
        odd = dict(GOOD, number=8, url="https://example.test/acme/widgets/pull/8", headRefName=5, bodyText="", mergeable="MAYBE")
        unknown = dict(GOOD, number=9, url="https://example.test/acme/widgets/pull/9", mergeable="UNKNOWN")
        self.put_cache({"v": 1, "fetchedAt": "2026-10-31T10:00:00Z", "openPrs": [full, odd, unknown]})
        got = {p["number"]: p for p in self.doc()["openPrs"]}
        self.assertEqual((got[7]["headRefName"], got[7]["bodyText"], got[7]["mergeable"]), ("feat/x", "Fixes the flaky wait.", "CONFLICTING"))
        for k in ("headRefName", "bodyText", "mergeable"):
            self.assertNotIn(k, got[8])
        self.assertEqual(got[9]["mergeable"], "UNKNOWN")

    def test_description_is_cut_to_500_and_checks_to_20(self):
        checks = [{"n": "c%d" % i, "state": "ok", "label": "c"} for i in range(30)]
        self.put_cache({"v": 1, "fetchedAt": "2026-10-31T10:00:00Z", "openPrs": [dict(GOOD, bodyText="x" * 900, checks=checks)]})
        pr = self.doc()["openPrs"][0]
        self.assertEqual((len(pr["bodyText"]), len(pr["checks"])), (500, 20))


NOW_MS = int(NOW * 1000)
SEARCH_AT = "2026-10-31T10:00:00Z"


def tracked(repo="acme/widgets", number=7, ok_ms=None, url=None, **over):
    ent = {"repo": repo, "number": number, "at": 1, "okAt": NOW_MS if ok_ms is None else ok_ms,
           "snap": {"state": "open", "mergeable": "conflicting", "head": "abc", "base": "main", "updatedAt": "2026-11-02T10:00:00Z",
                    "runs": [{"id": "1", "name": "build", "bucket": "failed", "url": ""}, {"id": "2", "name": "lint", "bucket": "passed", "url": ""},
                             {"id": "3", "name": "test", "bucket": "pending", "url": ""}, {"id": "4", "name": "req", "bucket": "missing", "url": ""}]},
           "meta": {"url": url or "https://github.com/%s/pull/%d" % (repo, number), "title": "T%d" % number, "draft": False,
                    "headRefName": "feat/x", "headRepo": ""}}
    ent.update(over)
    return ent


class TrackedPrsTests(Fixture):
    enable, put_cache, doc = OpenPrsTests.enable, OpenPrsTests.put_cache, OpenPrsTests.doc

    def put_state(self, entries, **top):
        p = self.base / "state" / "tracked-prs-state.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        doc = {"v": 1, "trackedAt": NOW_MS}
        doc.update(top)
        doc["prs"] = {"%s#%d" % (e["repo"].lower(), e["number"]): e for e in entries}
        p.write_text(json.dumps(doc), "utf-8")

    def put_search(self, entries):
        self.put_cache({"v": 1, "fetchedAt": SEARCH_AT, "openPrs": entries})

    def test_tracked_only_without_a_search_file_has_no_openPrsAt(self):
        self.put_state([tracked()])
        d = self.doc()
        self.assertNotIn("openPrsAt", d)
        (p,) = d["openPrs"]
        self.assertEqual((p["repo"], p["number"], p["title"], p["state"], p["tracked"], p["author"]), ("acme/widgets", 7, "T7", "open", True, ""))

    def test_mapping_of_checks_mergeable_and_branches(self):
        self.put_state([tracked()])
        (p,) = self.doc()["openPrs"]
        self.assertEqual(p["checks"], [{"n": "build", "state": "fail", "label": "build"}, {"n": "lint", "state": "ok", "label": "lint"},
                                       {"n": "test", "state": "run", "label": "test"}, {"n": "req", "state": "run", "label": "req"}])
        self.assertEqual((p["mergeable"], p["headRefName"], p["baseRefName"], p["updated"]), ("CONFLICTING", "feat/x", "main", "2026-11-02T10:00:00Z"))

    def test_draft_caps_and_labels(self):
        e = tracked()
        e["meta"]["draft"] = True
        e["snap"]["runs"] = [{"id": str(i), "name": "n" * 200, "bucket": "passed", "url": ""} for i in range(30)]
        self.put_state([e])
        (p,) = self.doc()["openPrs"]
        self.assertEqual((p["state"], len(p["checks"]), len(p["checks"][0]["n"]), len(p["checks"][0]["label"])), ("draft", 20, 120, 20))

    def test_repo_takes_the_canonical_case_of_meta_url(self):
        self.put_state([tracked(repo="Owner/Repo", url="https://github.com/owner/repo/pull/7")])
        self.assertEqual(self.doc()["openPrs"][0]["repo"], "owner/repo")

    def test_off_hides_tracked_entries(self):
        self.put_state([tracked()], off=True)
        self.assertNotIn("openPrs", self.doc())

    def test_ended_and_non_open_entries_are_not_listed(self):
        ended = tracked(number=1, endedAt=NOW_MS)
        ended["snap"]["state"] = "merged"
        closed = tracked(number=2)
        closed["snap"]["state"] = "closed"
        nosnap = {"repo": "acme/widgets", "number": 3, "at": 1, "error": "x", "errorAt": 1}
        self.put_state([ended, closed, nosnap, tracked(number=4)])
        self.assertEqual([p["number"] for p in self.doc()["openPrs"]], [4])

    def test_invalid_entries_are_dropped(self):
        bad_url = tracked(number=1, url="http://github.com/acme/widgets/pull/1")
        bad_title = tracked(number=2)
        bad_title["meta"]["title"] = 5
        no_meta = tracked(number=3)
        del no_meta["meta"]
        self.put_state([bad_url, bad_title, no_meta, tracked(number=4)])
        self.assertEqual([p["number"] for p in self.doc()["openPrs"]], [4])

    def test_search_twin_wins_only_when_tracked_is_stale_and_vice_versa(self):
        twin = dict(GOOD, repo="Acme/Widgets", author="octo", bodyText="Body", headRepo="fork/widgets", url="https://github.com/Acme/Widgets/pull/7")
        self.put_search([twin])
        self.put_state([tracked()])  # fresh: tracked wins, keeps author, bodyText, headRepo of the twin
        (p,) = self.doc()["openPrs"]
        self.assertEqual((p["title"], p["author"], p["bodyText"], p["headRepo"]), ("T7", "octo", "Body", "fork/widgets"))
        self.assertNotIn("tracked", p)
        self.put_state([tracked(ok_ms=NOW_MS - 16 * 60000)])  # older than 15 min: the search entry
        (p,) = self.doc()["openPrs"]
        self.assertEqual((p["title"], p["repo"]), ("Tune", "Acme/Widgets"))
        self.assertNotIn("tracked", p)

    def test_tracked_headRepo_beats_the_twins(self):
        e = tracked()
        e["meta"]["headRepo"] = "mine/widgets"
        self.put_search([dict(GOOD, headRepo="fork/widgets")])
        self.put_state([e])
        self.assertEqual(self.doc()["openPrs"][0]["headRepo"], "mine/widgets")

    def test_openPrsAt_is_the_search_time_only(self):
        self.put_search([GOOD])
        self.put_state([tracked(number=9)])
        d = self.doc()
        self.assertEqual(d["openPrsAt"], SEARCH_AT)
        self.assertEqual([p["number"] for p in d["openPrs"]], [7, 9])

    def test_old_tracked_only_entry_is_still_listed(self):
        self.put_state([tracked(ok_ms=NOW_MS - 3 * 3600 * 1000)])
        self.assertEqual(len(self.doc()["openPrs"]), 1)

    def test_300_entries_sorted_by_repo_case_insensitively_then_number(self):
        search = [dict(GOOD, repo="Beta/y", number=i + 1, url="https://example.test/b/%d" % i) for i in range(100)]
        self.put_search(search)
        self.put_state([tracked(repo="acme/x", number=i + 1) for i in range(200)])
        got = self.doc()["openPrs"]
        self.assertEqual(len(got), 300)
        self.assertEqual([(p["repo"], p["number"]) for p in got], [("acme/x", i + 1) for i in range(200)] + [("Beta/y", i + 1) for i in range(100)])

    def test_disabled_hides_tracked_entries(self):
        self.put_state([tracked()])
        self.enable(False)
        self.assertNotIn("openPrs", self.doc())

    def test_follow_carries_tracked_entries(self):
        self.put_state([tracked()])
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(fr.time, "time", return_value=NOW):
            fr.follow(self.adir, 0, 24, 3600, "unicode", fr.load_symbols("unicode"), max_ticks=1, open_prs=True)
        self.assertEqual(json.loads(out.getvalue().splitlines()[0])["openPrs"][0]["tracked"], True)

    def test_json_doc_with_a_plain_tuple_is_unchanged(self):
        d = fr.json_doc([], NOW, "unicode", fr.load_symbols("unicode"), open_prs=([GOOD], SEARCH_AT))
        self.assertEqual((d["openPrs"], d["openPrsAt"]), ([GOOD], SEARCH_AT))
        d = fr.json_doc([], NOW, "unicode", fr.load_symbols("unicode"), open_prs=([GOOD], None))
        self.assertNotIn("openPrsAt", d)


if __name__ == "__main__":
    unittest.main()
