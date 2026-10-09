"""Replay: ceremony.ledgerHelper (foreman_ledger tool, pure-ledger bash, off) on the fake provider.

After a reviewer PASS four ledger marks through the tool, or a pure-ledger bash compound, do not
use the recheck budget and the finish goes through. The tool closes V only after a PASS with no
revision since (traced attested, no stop_hold after it); before a review and after a FAIL it
refuses, and the escape-hatch finish leaves V open. A reviewer child closes V on the foreman's
ledger through the tool and may do nothing else with it. "off" keeps the old behaviour: no tool,
every ledger shell call counts. A foreman ledger shell call refused by a permission rule is traced ledger_call allowed false.
Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402
from test_replay_ceremony_gate import events  # noqa: E402

V_REFUSAL = "V closes after a reviewer PASS with no revision since"
RECHECK = {"ceremony": {"recheckBudget": 1}}


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestLedgerHelper(ReplayCase):
    def run_flow(self, tag, config=None, notices=2):
        rig = self.rig("lh-" + tag, load_fixture("ledger_helper"), config=config or RECHECK)
        (rig.project / "a.txt").write_text("alpha\n", "utf-8")
        pi = rig.start()
        sid = pi.session_id()
        recs = pi.prompt("[[replay:%s1]] build it" % tag, timeout=60)
        for _ in range(notices):
            recs += pi.wait_child_notify(timeout=180)[1]
        pi.close()
        return rig, sid, recs

    def ledger(self, rig, topic):
        return (rig.project / ".workflow" / ("LEDGER-%s.md" % topic)).read_text("utf-8")

    def test_four_tool_marks_after_pass_do_not_count(self):
        rig, sid, recs = self.run_flow("a")
        res = [(n, e) for n, e, _ in tool_results(recs) if n in ("foreman_ledger", "read")]
        self.assertEqual(res, [("foreman_ledger", False)] * 4 + [("read", False)], tool_results(recs))
        self.assertEqual([r["action"] for r in events(rig, sid, "recheck_budget")], ["start"])
        self.assertEqual(events(rig, sid, "finish_refused"), [])
        self.assertNotIn("- [ ]", self.ledger(rig, "la"))
        self.assertEqual([(r["kind"], r["allowed"], r["items"]) for r in events(rig, sid, "ledger_call")], [("mark", True, str(i)) for i in range(1, 5)])

    def test_pure_ledger_bash_after_pass_does_not_count(self):
        rig, sid, recs = self.run_flow("b")
        res = [(n, e) for n, e, _ in tool_results(recs) if n in ("bash", "read")]
        self.assertEqual(res, [("bash", False), ("bash", False), ("read", False)], tool_results(recs))
        self.assertEqual([r["action"] for r in events(rig, sid, "recheck_budget")], ["start"])
        self.assertNotIn("- [ ]", self.ledger(rig, "lb"))
        self.assertEqual([(r["kind"], r["allowed"]) for r in events(rig, sid, "ledger_call")], [("bash", True), ("bash", True)])

    def test_v_closed_by_tool_after_pass(self):
        rig, sid, recs = self.run_flow("c")
        res = tool_results(recs, "foreman_ledger")
        self.assertEqual([e for _, e, _ in res], [False], res)
        self.assertIn("- [x] V. fresh-eyes verification passed — closed by the foreman after a reviewer PASS", self.ledger(rig, "lc"))
        calls = events(rig, sid, "ledger_call")
        self.assertEqual([(r["kind"], r["items"], r.get("attested")) for r in calls], [("mark", "V", True)])
        trace = [r for r in rig.traces()["trace-" + "".join(c for c in sid if c.isalnum() or c in "-_")]]
        after = trace[trace.index(calls[0]):]
        self.assertEqual([r for r in after if r.get("event") in ("stop_hold", "finish_refused")], [])

    def test_v_refused_before_pass_and_after_fail_escape_hatch_keeps_it_open(self):
        rig, sid, recs = self.run_flow("d")
        res = tool_results(recs, "foreman_ledger")
        self.assertEqual([e for _, e, _ in res], [True, True], res)
        for _, _, text in res:
            self.assertIn(V_REFUSAL, text)
        self.assertEqual([(r["kind"], r["allowed"]) for r in events(rig, sid, "ledger_call")], [("mark", False)] * 2)
        self.assertEqual([r["missing"] for r in events(rig, sid, "ceremony_incomplete")], ["reviewer"])
        self.assertIn("- [ ] V. fresh-eyes verification passed", self.ledger(rig, "ld"))

    def test_off_has_no_tool_and_ledger_bash_counts(self):
        cfg = {"ceremony": {"recheckBudget": 1, "ledgerHelper": "off"}}
        rig, sid, recs = self.run_flow("f", config=cfg)
        res = [(n, e) for n, e, _ in tool_results(recs) if n in ("foreman_ledger", "bash")]
        self.assertEqual(res, [("foreman_ledger", True), ("bash", False), ("bash", True)], tool_results(recs))
        self.assertIn("[recheck_budget_exceeded]", tool_results(recs, "bash")[1][2])
        self.assertEqual([(r["action"], r["count"]) for r in events(rig, sid, "recheck_budget")], [("start", 0), ("deny", 2)])
        self.assertIn("- [ ] 2. b", self.ledger(rig, "lf"))

    def test_permission_denied_ledger_bash_traced_not_allowed(self):
        rig = self.rig("lh-h", load_fixture("ledger_helper"), permissions="baseline")
        pi = rig.start()
        sid = pi.session_id()
        res = tool_results(pi.prompt("[[replay:h1]] go", timeout=60), "bash")
        pi.close()
        self.assertEqual([e for _, e, _ in res], [True, False], res)
        self.assertIn("[pi-permission-system]", res[0][2])
        self.assertEqual([(r["kind"], r["allowed"]) for r in events(rig, sid, "ledger_call")], [("bash", False), ("bash", True)])

    def test_reviewer_child_closes_v_and_nothing_else(self):
        rig, sid, recs = self.run_flow("g")
        text = self.ledger(rig, "lg")
        self.assertIn("- [ ] 1. a", text, "a reviewer child may not mark other items")
        self.assertIn("- [x] V. fresh-eyes verification passed\n", text)
        self.assertEqual(events(rig, sid, "ledger_call"), [], "child calls are not foreman ledger calls")

    def test_upsert_appends_rewrites_keeps_state_and_is_idempotent(self):
        rig = self.rig("lh-i", load_fixture("ledger_helper"))
        pi = rig.start()
        sid = pi.session_id()
        res = tool_results(pi.prompt("[[replay:i1]] go", timeout=60), "foreman_ledger")
        pi.close()
        self.assertEqual([e for _, e, _ in res], [False, False, False, False, False, True], res)
        self.assertIn("added 2: - [ ] 2. b", res[0][2])
        self.assertIn("- [ ] 2. b2", res[1][2])
        self.assertIn("(no-op)", res[4][2])
        self.assertIn("item 9 not found", res[5][2])
        text = self.ledger(rig, "li")
        self.assertRegex(text, r"- \[x\] 2\. b3\n(?:  > \d{4}-\d{2}-\d{2} ledger [^\n]*\n){1,3}- \[ \] V\.")  # D8 hints sit under the item
        self.assertNotIn("b2", text)
        self.assertEqual([(r["kind"], r["allowed"], r.get("items")) for r in events(rig, sid, "ledger_call")][:3], [("upsert", True, "2"), ("upsert", True, "2"), ("mark", True, "2")])


if __name__ == "__main__":
    unittest.main()
