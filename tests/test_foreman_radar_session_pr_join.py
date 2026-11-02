"""scripts/foreman_radar.py --json: the live file's `repo` and `branch` reach each session node (the herdr-app mod joins feed PRs
to sessions by them), and the feed's `baseRefName` reaches `openPrs`."""
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

from test_foreman_radar import NOW, Fixture, live  # noqa: E402
import foreman_radar as fr  # noqa: E402

PR = {"repo": "acme/widgets", "number": 7, "title": "Tune", "url": "https://example.test/acme/widgets/pull/7",
      "state": "open", "author": "octo", "checks": []}


class SessionPrJoinTests(Fixture):
    def doc(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(fr.time, "time", return_value=NOW):
            self.assertEqual(fr.main(["--agent-dir", str(self.adir), "--json"]), 0)
        return json.loads(out.getvalue())

    def test_repo_and_branch_pass_through_to_the_node(self):
        self.put_live(dict(live("s-a", "a", "fm-a"), repo="acme/widgets", branch="feat/x"))
        (top,) = self.doc()["roots"]
        self.assertEqual((top["repo"], top["branch"]), ("acme/widgets", "feat/x"))

    def test_child_session_carries_its_own_repo_and_branch(self):
        self.put_live(dict(live("s-a", "a", "fm-a"), repo="acme/widgets", branch="main"))
        self.put_live(dict(live("s-b", "b", "fm-b", parent="fm-a"), repo="acme/gears", branch="feat/y"))
        (top,) = self.doc()["roots"]
        (child,) = [c for c in top["children"] if c["kind"] == "session"]
        self.assertEqual((child["repo"], child["branch"]), ("acme/gears", "feat/y"))

    def test_absent_or_invalid_values_leave_the_keys_out(self):
        self.put_live(dict(live("s-a", "a", "fm-a"), repo=5, branch=""))
        (top,) = self.doc()["roots"]
        self.assertNotIn("repo", top)
        self.assertNotIn("branch", top)

    def test_base_branch_of_a_feed_pr_passes_through_only_when_valid(self):
        p = self.base / "state" / "open-prs.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        odd = dict(PR, number=8, url="https://example.test/acme/widgets/pull/8", baseRefName=3)
        p.write_text(json.dumps({"v": 1, "fetchedAt": "2026-10-31T10:00:00Z", "openPrs": [dict(PR, baseRefName="main"), odd]}), "utf-8")
        got = {x["number"]: x for x in self.doc()["openPrs"]}
        self.assertEqual(got[7]["baseRefName"], "main")
        self.assertNotIn("baseRefName", got[8])


if __name__ == "__main__":
    unittest.main()
