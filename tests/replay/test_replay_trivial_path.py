"""Replay: the trivial builder path (frugal-roles D6, ledger items 9 and 21).

(i) The foreman triages trivial, writes a `Tier: trivial` ledger and launches one builder, which
fixes an internal line of calc.py (test_calc.py beside it). The finish passes with the ledger item
marked and no reviewer: no `triage_escalated`, no `finish_refused`. (ii) The same, but the builder
also edits test_calc.py: at finish the diff check escalates to standard (`triage_escalated
{from: trivial, to: standard, reason: test_file}`), the finish is refused until a reviewer passes.
Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402
from test_replay_ceremony_gate import events, gate_messages  # noqa: E402
from test_replay_diff_facts import git  # noqa: E402

CALC = "def add(a, b):\n    return a - b\n"
TEST = "from calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n"


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestTrivialPath(ReplayCase):
    def setup_project(self, name):
        rig = self.rig(name, load_fixture("trivial_path"))
        (rig.project / "calc.py").write_text(CALC, "utf-8")
        (rig.project / "test_calc.py").write_text(TEST, "utf-8")
        git(rig.project, "add", "calc.py", "test_calc.py")
        git(rig.project, "commit", "-q", "-m", "init")
        return rig

    def test_one_file_fix_closes_trivial_without_reviewer(self):
        rig = self.setup_project("trivial-ok")
        pi = rig.start()
        sid = pi.session_id()
        recs = pi.prompt("[[replay:t1]] fix add", timeout=60)
        _, done = pi.wait_child_notify(timeout=180)
        pi.close()
        self.assertIn("return a + b", (rig.project / "calc.py").read_text("utf-8"))
        self.assertIn("- [x] 1.", (rig.project / ".workflow" / "LEDGER-calc.md").read_text("utf-8"))
        self.assertEqual(gate_messages(recs + done), [])
        for name in ("triage_escalated", "finish_refused", "ceremony_incomplete"):
            self.assertEqual(events(rig, sid, name), [], name)
        self.assertEqual([r["role"] for r in events(rig, sid, "role_launch")], ["builder"])

    def test_edited_test_file_escalates_and_requires_a_review(self):
        rig = self.setup_project("trivial-esc")
        pi = rig.start()
        sid = pi.session_id()
        recs = pi.prompt("[[replay:t3]] fix add", timeout=60)
        _, built = pi.wait_child_notify(timeout=180)
        notice, reviewed = pi.wait_child_notify(timeout=180)
        pi.close()
        self.assertIn("verdict: PASS", notice)
        self.assertEqual([(r["from"], r["to"], r["reason"]) for r in events(rig, sid, "triage_escalated")],
                         [("trivial", "standard", "test_file")])
        msgs = gate_messages(recs + built + reviewed)
        self.assertEqual(len(msgs), 1, msgs)
        self.assertIn("tier standard requires reviewer", msgs[0])
        self.assertIn("Not trivial after all (test_file: test file changed: test_calc.py)", msgs[0])
        self.assertEqual([r["missing"] for r in events(rig, sid, "finish_refused")], ["reviewer"])
        self.assertEqual(events(rig, sid, "ceremony_incomplete"), [])
        self.assertEqual([r["role"] for r in events(rig, sid, "role_launch")], ["builder", "reviewer"])


if __name__ == "__main__":
    unittest.main()
