"""Replay: foreman read budget and recheck budget (ceremony.foremanReads, ceremony.recheckBudget)
on the fake provider.

Warn notice in the result; deny, a refused explorer launch does not lift it, a started explorer
lifts it once per phase, the second deny needs `/foreman budget lift`; a codemode script with
several nested reads counts once; a nested call is refused once the window is over deny; a
supervisor reply window is exempt; after a reviewer PASS the foreman gets recheckBudget reads
and is told to finish, a reviewer FAIL resets, a .workflow/ write does not; the triage result
names the finish steps.
Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, notifications, tool_results, trace_of  # noqa: E402
from test_launch_policy import is_request, wait_records  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


def budget(before=(2, 3), after=(1, 2), recheck=1):
    return {"ceremony": {"foremanReads": {"before": {"warn": before[0], "deny": before[1]}, "after": {"warn": after[0], "deny": after[1]}}, "recheckBudget": recheck}}


def events(rig, name):
    return [r for r in trace_of(rig.traces(), "foreman") if r.get("event") == name]


def short(recs):
    return [(r.get("phase"), r.get("count"), r.get("action"), r.get("by")) for r in recs]


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestReadBudget(ReplayCase):
    def start(self, name, cfg):
        rig = self.rig(name, load_fixture("read_budget"), config=cfg)
        (rig.project / "a.txt").write_text("alpha\n", "utf-8")
        return rig, rig.start()

    def test_warn_deny_lift_and_user_command(self):
        rig, pi = self.start("rb-flow", budget())
        res = tool_results(pi.prompt("[[replay:warn]] go", timeout=60))
        self.assertEqual([e for _, e, _ in res], [False, False], res)
        self.assertNotIn("read budget", res[0][2])
        self.assertTrue(res[1][2].startswith("pi-foreman: read budget 2 of 3 read calls before the first launch. Launch the explorer"), res[1][2])

        res = tool_results(pi.prompt("[[replay:deny]] go", timeout=90))
        names = [(n, e) for n, e, _ in res]
        self.assertEqual(names, [("read", False)] * 3 + [("read", True), ("subagent", True), ("read", True), ("subagent", False)] + [("read", False)] * 2 + [("read", True), ("subagent", False)] + [("read", False)] * 1 + [("read", False), ("read", True)], res)
        self.assertIn("[read_budget_exceeded]", res[3][2])
        self.assertIn("a started explorer run lifts the limit", res[3][2])
        self.assertIn("[read_budget_exceeded]", res[5][2], "a refused explorer launch does not lift")
        self.assertIn("ask the owner to run /foreman budget lift", res[-1][2], "second deny in the phase")

        notes = notifications(pi.prompt("/foreman budget lift", timeout=30))
        self.assertTrue(any("read budget lifted" in n for n in notes), notes)
        res = tool_results(pi.prompt("[[replay:after]] go", timeout=60))
        self.assertEqual([e for _, e, _ in res], [False], res)
        pi.close()
        got = short(events(rig, "read_budget"))
        self.assertEqual(got[0], ("before", 2, "warn", None))
        self.assertEqual([g for g in got if g[2] == "lift"], [("before", 3, "lift", "explorer"), ("after", 2, "lift", "explorer"), ("after", 2, "lift", "user")])
        self.assertIn(("before", 3, "deny", None), got)

    def test_codemode_script_counts_once(self):
        rig, pi = self.start("rb-script", budget(before=(3, 4)))
        res = tool_results(pi.prompt("[[replay:script]] go", timeout=90))
        outer = [t for n, e, t in res if n == "codemode"]
        self.assertTrue(outer and "three reads" in outer[0], res)
        denied = [t for n, e, t in res if e and "[read_budget_exceeded]" in t]
        pi.close()
        self.assertEqual(len(denied), 1, res)
        counts = [r["count"] for r in events(rig, "read_budget") if r["action"] == "deny"]
        self.assertEqual(counts, [4], "script + three reads = 4 units, the fifth call is denied")

    def test_nested_call_refused_over_deny(self):
        rig, pi = self.start("rb-nested", budget(before=(3, 4)))
        res = tool_results(pi.prompt("[[replay:nested]] go", timeout=90))
        pi.close()
        texts = [t for n, e, t in res if n == "codemode"]
        self.assertTrue(texts and "[read_budget_exceeded]" in texts[0], res)

    def test_supervisor_window_is_exempt(self):
        rig, pi = self.start("rb-supervisor", budget(after=(1, 1)))
        pi.prompt("[[replay:sup1]] go", timeout=60)
        seen = {"request": False}

        def done(rec, _out):
            seen["request"] = seen["request"] or is_request(rec)
            return seen["request"] and rec.get("type") == "agent_settled"

        res = tool_results(wait_records(pi, done, 120))
        pi.close()
        self.assertEqual([(n, e) for n, e, _ in res], [("read", False)] * 3 + [("subagent_supervisor", False)], res)
        self.assertEqual([r for r in events(rig, "read_budget") if r["action"] == "deny"], [])


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestRecheckBudget(ReplayCase):
    def test_refused_after_pass_reset_by_fail_and_triage_names_the_reviewer(self):
        rig = self.rig("rb-recheck", load_fixture("read_budget"), config=budget(after=(8, 9), recheck=1))
        (rig.project / "a.txt").write_text("alpha\n", "utf-8")
        pi = rig.start()
        recs = pi.prompt("[[replay:rc1]] build it", timeout=60)
        triage = tool_results(recs, "foreman_triage")
        self.assertIn("Before you finish: a builder run must complete, a reviewer must pass.", triage[0][2])
        _, built = pi.wait_child_notify(timeout=180)  # builder done -> rc2 launches the reviewer
        _, passed = pi.wait_child_notify(timeout=180)  # reviewer PASS -> rc3
        res3 = tool_results(passed)
        self.assertEqual([(n, e) for n, e, _ in res3][:3], [("read", False), ("read", True), ("subagent", False)], res3)
        self.assertIn("[recheck_budget_exceeded]", res3[1][2])
        self.assertIn("the reviewer passed; finish now", res3[1][2])
        _, failed = pi.wait_child_notify(timeout=180)  # reviewer FAIL -> rc4
        res4 = tool_results(failed)
        self.assertEqual([(n, e) for n, e, _ in res4], [("read", False), ("read", False)], res4)
        pi.close()
        got = [(r["action"], r["count"]) for r in events(rig, "recheck_budget")]
        self.assertEqual(got, [("start", 0), ("deny", 2), ("reset_fail", 1)])

    def test_ledger_write_after_pass_keeps_the_recheck_budget(self):
        # a .workflow/ note is no project-file change: the PASS stands, the next read is refused
        rig = self.rig("rb-edit", load_fixture("read_budget"), config=budget(after=(8, 9), recheck=1))
        (rig.project / "a.txt").write_text("alpha\n", "utf-8")
        pi = rig.start()
        pi.prompt("[[replay:ed1]] build it", timeout=60)
        pi.wait_child_notify(timeout=180)
        _, passed = pi.wait_child_notify(timeout=180)
        res = tool_results(passed)
        pi.close()
        self.assertEqual([(n, e) for n, e, _ in res], [("read", False), ("write", False), ("read", True)], res)
        self.assertIn("[recheck_budget_exceeded]", res[2][2])
        got = [a for a, _ in [(r["action"], r["count"]) for r in events(rig, "recheck_budget")]]
        self.assertEqual(got, ["start", "deny"])


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestUserPromptReset(ReplayCase):
    def test_new_prompt_restarts_the_before_budget(self):
        rig = self.rig("rb-user", load_fixture("read_budget"), config=budget(before=(1, 2)))
        (rig.project / "a.txt").write_text("alpha\n", "utf-8")
        pi = rig.start()
        res = tool_results(pi.prompt("[[replay:usr]] go", timeout=60))
        self.assertEqual([e for _, e, _ in res], [False, False, True], res)
        res = tool_results(pi.prompt("[[replay:usr]] again", timeout=60))
        self.assertEqual([e for _, e, _ in res], [False, False, True], res)
        pi.close()
        self.assertEqual([r["action"] for r in events(rig, "read_budget") if r["action"] == "reset_user"], ["reset_user"])


if __name__ == "__main__":
    unittest.main()
