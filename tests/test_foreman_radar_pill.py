"""scripts/foreman_radar.py --json: the pill's inputs. A tracked entry's head sha and merge state reach the feed entry (the sidebar mod's `prExtras`),
and `waits[].review` (the session's review facts of its owned PRs) is copied like `unreviewed`, only when well-formed; a live file without it, or a
store entry without head and merge state, gives the same output as before."""
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
from test_foreman_radar_open_prs import TrackedPrsTests, tracked  # noqa: E402
import foreman_radar as fr  # noqa: E402

HEAD = "0123456789abcdef0123456789abcdef01234567"


def wait(**extra):
    return dict({"id": "pr_watch", "kind": "pr", "note": "1 pr watch", "ageSeconds": 0, "leftSeconds": 0, "prs": [5]}, **extra)


class FeedPillInputs(Fixture):
    enable, put_cache, doc, put_state = TrackedPrsTests.enable, TrackedPrsTests.put_cache, TrackedPrsTests.doc, TrackedPrsTests.put_state

    def test_head_and_merge_state_are_passed_through(self):
        e = tracked()
        e["snap"].update(head=HEAD, mergeState="blocked")
        self.put_state([e])
        (p,) = self.doc()["openPrs"]
        self.assertEqual((p["head"], p["mergeState"]), (HEAD, "blocked"))

    def test_an_entry_without_them_has_neither_key(self):
        e = tracked()
        del e["snap"]["head"]
        self.put_state([e])
        (p,) = self.doc()["openPrs"]
        self.assertNotIn("head", p)
        self.assertNotIn("mergeState", p)

    def test_a_non_string_value_is_dropped(self):
        e = tracked()
        e["snap"].update(head=7, mergeState=["x"])
        self.put_state([e])
        (p,) = self.doc()["openPrs"]
        self.assertNotIn("head", p)
        self.assertNotIn("mergeState", p)


class ReviewPassThrough(Fixture):
    def waits_of(self, waits):
        top = live("s-v", "v", "fm-v", hb=0)
        top["waits"] = waits
        self.put_live(top)
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(fr.time, "time", return_value=NOW):
            self.assertEqual(fr.main(["--agent-dir", str(self.adir), "--json"]), 0)
        (root,) = json.loads(out.getvalue())["roots"]
        return root["waits"]

    def test_review_facts_are_copied_when_well_formed(self):
        good = {"n": 5, "repo": "owner/repo", "host": "github.com", "head": HEAD, "state": "ok"}
        flagged = {"n": 6, "repo": "owner/repo", "host": "", "head": HEAD, "state": "unreviewed", "noChecks": True}
        bad = [{"n": 7, "repo": "r", "head": HEAD, "state": "ready"}, {"n": True, "repo": "r", "head": HEAD, "state": "ok"},
               {"n": 8, "repo": "r", "state": "ok"}, "junk"]
        (w,) = self.waits_of([wait(review=[good, flagged] + bad)])
        self.assertEqual(w["review"], [good, flagged])

    def test_a_live_file_without_review_gives_the_same_wait(self):
        for w in self.waits_of([wait(), wait(review=[]), wait(review="junk")]):
            self.assertNotIn("review", w)
            self.assertEqual(w["prs"], [5])

    def test_unreviewed_still_passes_through_beside_review(self):
        (w,) = self.waits_of([wait(unreviewed=[{"n": 5, "repo": "o/r", "host": ""}], review=[{"n": 5, "repo": "o/r", "host": "", "head": HEAD, "state": "wip"}])])
        self.assertEqual(w["unreviewed"], [{"n": 5, "repo": "o/r", "host": ""}])
        self.assertEqual(w["review"][0]["state"], "wip")


# the imported class only lends its helpers: its own tests run from their module
del TrackedPrsTests

if __name__ == "__main__":
    unittest.main()
