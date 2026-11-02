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


if __name__ == "__main__":
    unittest.main()
