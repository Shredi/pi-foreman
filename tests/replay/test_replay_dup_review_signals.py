"""Replay: a reviewer launch after a PASS is allowed when the worktree changed since (a new untracked
file written outside the foreman, as a builder would), traced review_dup_allowed with the signal;
with nothing changed it is refused (review_dup_refused). Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402
from test_replay_ceremony_gate import events  # noqa: E402
from test_replay_review_gate import notifies  # noqa: E402


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestDupReviewSignals(ReplayCase):
    def second_review(self, tag, change):
        rig = self.rig("drs-" + tag, load_fixture("dup_review_signals"))
        pi = rig.start()
        sid = pi.session_id()
        recs = pi.prompt("[[replay:n1]] build it", timeout=60)
        recs += notifies(pi, 2)
        pi.prompt("[[replay:n3]] status", timeout=60)
        change(rig)
        recs += pi.prompt("[[replay:n4]] review again", timeout=60)
        pi.close()
        return rig, sid, [(n, e) for n, e, _ in tool_results(recs) if n == "subagent"]

    def test_new_untracked_file_after_pass_allows_the_next_review(self):
        def change(rig):
            (rig.project / "docs").mkdir(exist_ok=True)
            (rig.project / "docs" / "new-note.md").write_text("a note\n", "utf-8")

        rig, sid, launches = self.second_review("new", change)
        self.assertEqual(launches, [("subagent", False)] * 3)
        self.assertEqual(events(rig, sid, "review_dup_refused"), [])
        allowed = events(rig, sid, "review_dup_allowed")
        self.assertEqual([r["agent"] for r in allowed], ["reviewer"])
        self.assertIn("tree", allowed[0]["signals"])

    def test_nothing_changed_refuses_the_next_review(self):
        rig, sid, launches = self.second_review("none", lambda rig: None)
        self.assertEqual(launches, [("subagent", False)] * 2 + [("subagent", True)])
        self.assertEqual([r["agent"] for r in events(rig, sid, "review_dup_refused")], ["reviewer"])
        self.assertEqual(events(rig, sid, "review_dup_allowed"), [])


if __name__ == "__main__":
    unittest.main()
