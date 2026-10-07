"""Replay: ceremony gate (plan D1, D2) on the fake provider.

D1 trivial bound: a small edit at trivial passes; a write that would cross the line bound is
refused, the tier escalates to standard (trace `triage_escalated`) and the next edit is refused
by the triage gate; a new file at trivial is refused. D2 required steps: a standard session that
finishes without a builder is refused twice (naming the missing steps), then passes visibly
(trace `ceremony_incomplete`, a notify); after a builder and a reviewer (PASS) it finishes at
once; a builder run that failed does not count. Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import PROVIDER_A, load_fixture, notifications, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

LINES = "".join("line %d\n" % i for i in range(50))


def script():
    s = load_fixture("ceremony_gate")
    s["foreman"]["cross"][2]["tools"][0]["arguments"]["content"] = LINES
    return s


def events(rig, sid, name):
    safe = "".join(c for c in sid if c.isalnum() or c in "-_")
    return [r for r in rig.traces().get("trace-" + safe, []) if r.get("event") == name]


def gate_messages(records):
    out = []
    for r in records:
        entry = r.get("entry") if isinstance(r.get("entry"), dict) else {}
        if r.get("type") == "entry_appended" and entry.get("customType") == "pi-foreman-ceremony-gate":
            out.append(entry.get("content"))
    return out


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestTrivialBound(ReplayCase):
    def test_small_edit_crossing_write_and_new_file(self):
        rig = self.rig("cg-bound", script())
        a_txt = rig.project / "a.txt"
        a_txt.write_text("alpha\n", "utf-8")

        pi = rig.start()
        sid = pi.session_id()
        recs = pi.prompt("[[replay:small]] fix the typo", timeout=60)
        self.assertEqual([(n, e) for n, e, _ in tool_results(recs)], [("foreman_triage", False), ("edit", False)])
        self.assertEqual(a_txt.read_text("utf-8"), "beta\n")
        self.assertEqual(events(rig, sid, "triage_escalated"), [])
        self.assertEqual(events(rig, sid, "finish_refused"), [], "trivial has no required steps")
        pi.close()

        a_txt.write_text("alpha\n", "utf-8")
        pi = rig.start()
        sid = pi.session_id()
        res = tool_results(pi.prompt("[[replay:cross]] fix it", timeout=90))
        self.assertEqual([(n, e) for n, e, _ in res], [("foreman_triage", False), ("edit", False), ("write", True), ("edit", True)], res)
        self.assertIn("refused: at tier trivial the foreman changes at most 2 files, 40 changed lines", res[2][2])
        self.assertIn("delegate the rest to a builder", res[2][2])
        self.assertIn("the tier is standard", res[3][2])
        self.assertEqual(a_txt.read_text("utf-8"), "beta\n", "the crossing write must not land")
        [esc] = events(rig, sid, "triage_escalated")
        self.assertEqual((esc["from"], esc["to"], esc["files"], esc["newFiles"]), ("trivial", "standard", 1, 0))
        self.assertGreater(esc["lines"], 40)
        pi.close()

        pi = rig.start()
        sid = pi.session_id()
        res = tool_results(pi.prompt("[[replay:newfile]] add a note", timeout=60))
        self.assertEqual([(n, e) for n, e, _ in res], [("foreman_triage", False), ("write", True)], res)
        self.assertIn("1 new files", res[1][2])
        self.assertFalse((rig.project / "new.txt").exists())
        [esc] = events(rig, sid, "triage_escalated")
        self.assertEqual(esc["newFiles"], 1)
        pi.close()


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestRequiredSteps(ReplayCase):
    def test_finish_without_builder_refused_twice_then_forced_pass(self):
        rig = self.rig("cg-nobuild", script())
        pi = rig.start()
        sid = pi.session_id()
        recs = pi.prompt("[[replay:nobuild]] build it", timeout=90)
        pi.close()
        msgs = gate_messages(recs)
        self.assertEqual(len(msgs), 2, msgs)
        self.assertIn("finish refused: tier standard requires builder, reviewer; launch them or ask the owner to lower the tier with /ceremony", msgs[0])
        self.assertEqual([(r["tier"], r["missing"]) for r in events(rig, sid, "finish_refused")], [("standard", "builder,reviewer")] * 2)
        self.assertEqual([(r["tier"], r["missing"]) for r in events(rig, sid, "ceremony_incomplete")], [("standard", "builder,reviewer")])
        self.assertTrue(any("finished with ceremony incomplete: missing builder, reviewer" in n for n in notifications(recs)), notifications(recs))

    def test_builder_and_reviewer_let_the_finish_pass(self):
        rig = self.rig("cg-full", script())
        pi = rig.start()
        sid = pi.session_id()
        recs = pi.prompt("[[replay:full]] build it", timeout=60)
        self.assertEqual([(n, e) for n, e, _ in tool_results(recs)], [("foreman_triage", False), ("write", False), ("subagent", False)], tool_results(recs))
        _, built = pi.wait_child_notify(timeout=180)
        notice, reviewed = pi.wait_child_notify(timeout=180)
        pi.close()
        self.assertIn("verdict: PASS", notice)
        self.assertEqual(gate_messages(recs + built + reviewed), [])
        self.assertEqual(events(rig, sid, "finish_refused"), [])
        self.assertEqual(events(rig, sid, "ceremony_incomplete"), [])

    def test_failed_builder_does_not_count(self):
        cfg = {"providers": {PROVIDER_A: {"roles": {"builder": {"model": "%s/review-error" % PROVIDER_A}}}}}
        rig = self.rig("cg-failed", script(), config=cfg)
        pi = rig.start()
        sid = pi.session_id()
        pi.prompt("[[replay:failed]] build it", timeout=60)
        notice, more = pi.wait_child_notify(timeout=180)
        pi.close()
        self.assertNotIn("completed", notice.splitlines()[0])
        self.assertEqual([r["missing"] for r in events(rig, sid, "finish_refused")], ["builder,reviewer"] * 2)
        self.assertEqual(len(events(rig, sid, "ceremony_incomplete")), 1)


if __name__ == "__main__":
    unittest.main()
