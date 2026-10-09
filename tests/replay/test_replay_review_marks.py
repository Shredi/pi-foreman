"""Replay: a reviewer PASS marks its `N. PASS` items in the bound ledger (retro-harvest item 1).

The reviewer's overall PASS carries `1. PASS`, `2. PASS` and `3. FAIL` lines: the harness ticks 1 and
2 with the note "verified by reviewer PASS", leaves 3 and V open, and traces
`ledger_mark_by_review` once although the result arrives both inline and as a completion notice.
A FAIL verdict marks nothing. Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402
from test_replay_ceremony_gate import events  # noqa: E402


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestReviewMarks(ReplayCase):
    def run_flow(self, tag):
        rig = self.rig("rm-" + tag, load_fixture("review_marks"))
        pi = rig.start()
        sid = pi.session_id()
        pi.prompt("[[replay:%s1]] build it" % tag, timeout=60)
        for _ in range(2):
            pi.wait_child_notify(timeout=180)
        pi.close()
        ledger = (rig.project / ".workflow" / ("LEDGER-m%s.md" % tag)).read_text("utf-8")
        return rig, sid, ledger

    def test_pass_marks_the_pass_items_only(self):
        rig, sid, ledger = self.run_flow("p")
        self.assertIn("- [x] 1. first — verified by reviewer PASS", ledger)
        self.assertIn("- [x] 2. second — verified by reviewer PASS", ledger)
        self.assertIn("- [ ] 3. third", ledger)
        self.assertIn("- [ ] V. fresh-eyes verification passed", ledger)
        self.assertEqual([(r["items"], r.get("skipped")) for r in events(rig, sid, "ledger_mark_by_review")], [("1,2", "")])

    def test_fail_marks_nothing(self):
        rig, sid, ledger = self.run_flow("f")
        self.assertNotIn("- [x]", ledger)
        self.assertEqual(events(rig, sid, "ledger_mark_by_review"), [])


if __name__ == "__main__":
    unittest.main()
