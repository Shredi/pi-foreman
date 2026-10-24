"""Replay: foreman read budget reminders and recheck budget (ceremony.foremanReads, ceremony.recheckBudget)
on the fake provider.

The read budget only reminds: at warn the result carries a reminder and again every `every` reads, and
no read is ever refused; a started explorer restarts the count in phase after; a codemode script with
several nested reads counts once; a supervisor reply window is exempt; `/foreman budget lift` has nothing
to lift. After a reviewer PASS the foreman gets recheckBudget reads and is told to finish, a reviewer FAIL
resets, a .workflow/ write does not; the triage result names the finish steps.
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
    return {"ceremony": {"foremanReads": {"before": {"warn": before[0], "every": before[1]}, "after": {"warn": after[0], "every": after[1]}}, "recheckBudget": recheck}}


def reminded(res):
    return [i for i, (_, _, text) in enumerate(res) if "you have read" in text]


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

    def test_reminders_repeat_and_no_read_is_refused(self):
        rig, pi = self.start("rb-flow", budget())
        res = tool_results(pi.prompt("[[replay:warn]] go", timeout=60))
        self.assertEqual([e for _, e, _ in res], [False, False], res)
        self.assertNotIn("you have read", res[0][2])
        self.assertTrue(res[1][2].startswith("pi-foreman: you have read 2 times; you should have enough to delegate: launch an explorer or builder for further exploration."), res[1][2])

        res = tool_results(pi.prompt("[[replay:remind]] go", timeout=90))
        names = [(n, e) for n, e, _ in res]
        # the first launch names an output file and is refused by the launch guard: it starts no run, so the count goes on
        self.assertEqual(names, [("read", False)] * 4 + [("subagent", True)] + [("read", False)] + [("subagent", False)] + [("read", False)] * 3 + [("subagent", False)] + [("read", False)] * 3, res)
        self.assertEqual(reminded(res), [1, 5, 7, 9, 11, 13], res)
        self.assertNotIn("[read_budget_exceeded]", "".join(t for _, _, t in res))

        notes = notifications(pi.prompt("/foreman budget lift", timeout=30))
        self.assertTrue(any("nothing to lift" in n for n in notes), notes)
        res = tool_results(pi.prompt("[[replay:after]] go", timeout=60))
        self.assertEqual([e for _, e, _ in res], [False], res)
        self.assertEqual(reminded(res), [], res)
        pi.close()
        got = short(events(rig, "read_budget"))
        self.assertEqual([g for g in got if g[2] == "remind"], [("before", 2, "remind", None), ("before", 2, "remind", None), ("before", 5, "remind", None), ("after", 1, "remind", None), ("after", 3, "remind", None), ("after", 1, "remind", None), ("after", 3, "remind", None)])
        self.assertEqual([g for g in got if g[2] not in ("remind", "reset_user")], [], "no deny and no lift")

    def test_codemode_script_counts_once(self):
        rig, pi = self.start("rb-script", budget(before=(3, 3)))
        res = tool_results(pi.prompt("[[replay:script]] go", timeout=90))
        pi.close()
        outer = [t for n, e, t in res if n == "codemode"]
        self.assertTrue(outer and "three reads" in outer[0], res)
        self.assertEqual([e for _, e, _ in res], [False] * len(res), res)
        self.assertEqual(reminded(res), [5], "the script's three nested reads are one unit, so the reminder falls on the second top-level read")
        self.assertEqual(short(events(rig, "read_budget")), [("before", 3, "remind", None)])

    def test_nested_call_is_never_refused(self):
        rig, pi = self.start("rb-nested", budget(before=(3, 3)))
        res = tool_results(pi.prompt("[[replay:nested]] go", timeout=90))
        pi.close()
        texts = [t for n, e, t in res if n == "codemode"]
        self.assertTrue(texts and "nested read ok" in texts[0], res)
        self.assertEqual([e for _, e, _ in res], [False] * len(res), res)
        self.assertEqual(reminded(res), [2], res)

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
        self.assertEqual([r for r in events(rig, "read_budget") if r["action"] == "remind"], [], "the supervisor window is not counted")


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestRecheckBudget(ReplayCase):
    def test_refused_after_pass_reset_by_fail_and_triage_names_the_reviewer(self):
        cfg = budget(after=(8, 9), recheck=1)
        cfg["ceremony"]["reviewPerRevision"] = False  # the flow needs a second reviewer after the PASS
        rig = self.rig("rb-recheck", load_fixture("read_budget"), config=cfg)
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
        self.assertEqual([e for _, e, _ in res], [False, False, False], res)
        self.assertEqual(reminded(res), [0, 2], res)
        res = tool_results(pi.prompt("[[replay:usr]] again", timeout=60))
        self.assertEqual([e for _, e, _ in res], [False, False, False], res)
        self.assertEqual(reminded(res), [0, 2], "the new prompt restarts the count")
        pi.close()
        self.assertEqual([r["action"] for r in events(rig, "read_budget") if r["action"] == "reset_user"], ["reset_user"])


if __name__ == "__main__":
    unittest.main()
