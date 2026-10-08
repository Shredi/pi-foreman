"""Replay: reviewer finish step under ceremony.reviewGate "pass" (default) on the fake provider.

A reviewer FAIL leaves the step open: the finish is refused naming reviewer, a re-review PASS lets
it pass. A builder launch after a FAIL re-opens it until a fresh PASS. A finalizer launch and a
scratchpad write after a PASS keep it; a builder launch after a PASS re-opens it. Each reviewer
launch while the step is re-opened is traced as `rereview` {role, after}. After two refusals per
user prompt the finish passes with trace `ceremony_incomplete`. "verdict" keeps the old rule.
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


def rereviews(rig, sid):
    return [(r["role"], r["after"]) for r in events(rig, sid, "rereview")]


def notifies(pi, n, timeout=180):
    out = []
    for _ in range(n):
        out += pi.wait_child_notify(timeout=timeout)[1]
    return out


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestReviewGate(ReplayCase):
    def test_fail_refused_then_rereview_pass(self):
        rig = self.rig("rg-fail", load_fixture("review_gate"))
        pi = rig.start()
        sid = pi.session_id()
        recs = pi.prompt("[[replay:a1]] build it", timeout=60)
        recs += notifies(pi, 3)
        pi.close()
        msgs = gate_messages(recs)
        self.assertEqual(msgs, ["pi-foreman: finish refused: tier standard requires reviewer (re-review needed: last verdict FAIL); launch them or ask the owner to lower the tier with /ceremony."])
        self.assertEqual([r["missing"] for r in events(rig, sid, "finish_refused")], ["reviewer"])
        self.assertEqual(events(rig, sid, "ceremony_incomplete"), [])
        self.assertEqual(rereviews(rig, sid), [("reviewer", "fail")])

    def test_fail_then_builder_needs_a_fresh_pass(self):
        rig = self.rig("rg-revise", load_fixture("review_gate"))
        pi = rig.start()
        sid = pi.session_id()
        recs = pi.prompt("[[replay:f1]] build it", timeout=60)
        recs += notifies(pi, 4)
        pi.close()
        self.assertEqual(len(gate_messages(recs)), 1, gate_messages(recs))
        self.assertIn("requires reviewer (re-review needed: last verdict FAIL)", gate_messages(recs)[0])
        self.assertEqual([r["missing"] for r in events(rig, sid, "finish_refused")], ["reviewer"])
        self.assertEqual(events(rig, sid, "ceremony_incomplete"), [])
        self.assertEqual(rereviews(rig, sid), [("reviewer", "fail")])

    def test_pass_finalizer_ok_then_builder_reopens_and_escape_hatch(self):
        rig = self.rig("rg-pass", load_fixture("review_gate"))
        pi = rig.start()
        sid = pi.session_id()
        recs = pi.prompt("[[replay:p1]] build it", timeout=60)
        recs += notifies(pi, 3)
        self.assertEqual(gate_messages(recs), [], "a finalizer and a scratchpad write after the PASS keep the step")
        self.assertEqual(events(rig, sid, "finish_refused"), [])
        self.assertEqual(rereviews(rig, sid), [])

        recs = pi.prompt("[[replay:p5]] one more change", timeout=60)
        recs += notifies(pi, 2)
        pi.close()
        msgs = gate_messages(recs)
        self.assertEqual(len(msgs), 2, msgs)
        self.assertIn("requires reviewer (re-review needed: revised after the last PASS)", msgs[0])
        self.assertIn("requires reviewer (re-review needed: last verdict FAIL)", msgs[1])
        self.assertEqual([r["missing"] for r in events(rig, sid, "finish_refused")], ["reviewer"] * 2)
        self.assertEqual([(r["tier"], r["missing"]) for r in events(rig, sid, "ceremony_incomplete")], [("standard", "reviewer")])
        self.assertEqual(rereviews(rig, sid), [("reviewer", "revision")])

    def test_verdict_mode_lets_a_fail_count(self):
        rig = self.rig("rg-verdict", load_fixture("review_gate"), config={"ceremony": {"reviewGate": "verdict"}})
        pi = rig.start()
        sid = pi.session_id()
        recs = pi.prompt("[[replay:a1]] build it", timeout=60)
        recs += notifies(pi, 2)
        pi.close()
        self.assertEqual(gate_messages(recs), [])
        self.assertEqual(events(rig, sid, "finish_refused"), [])


if __name__ == "__main__":
    unittest.main()
