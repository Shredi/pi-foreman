"""Replay: plan checkpoint and the heavy builder gate (planner ledger items 6-11, 21) on the fake provider.

At tier heavy a builder launch is refused until the owner approved the current plan file through
`foreman_checkpoint` (`launch_refused` plan_required / checkpoint_pending / plan_changed, also for
tasks, chain, chain-parallel and resume forms); approve lets the next builder through; revise returns
the owner's words and needs a new checkpoint; reject stops builders and names `plan` in the finish
refusal; no answer or no UI stays pending. The dialog raises the Herdr blocked signal. The rigs use
the installer's permission baseline, so the tool runs through the real permission system.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, notifications, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

LEDGER = "# Requirements Ledger: ck\nTier: heavy\n\n- [x] 1. synthetic item\n"
PLAN = "# Widget\n\n## Goal\nShip the widget.\n\n## Approach\nOne builder.\n\n## Verification\nTests.\n"
TITLE = "pi-foreman checkpoint: plan-ck.md ("


def script(run=""):
    raw = json.dumps(load_fixture("checkpoint"))
    for k, v in (("LEDGER_STD", LEDGER.replace("heavy", "standard")), ("LEDGER", LEDGER), ("PLAN", PLAN), ("RUN", run)):
        raw = raw.replace("{{%s}}" % k, json.dumps(v)[1:-1])
    return json.loads(raw)


def events(rig, name):
    return [r for recs in rig.traces().values() for r in recs if r.get("event") == name]


def dialogs(records):
    return [r for r in records if r.get("type") == "extension_ui_request" and r.get("method") in ("select", "confirm", "input", "editor")]


def gate_messages(records):
    out = []
    for r in records:
        entry = r.get("entry") if isinstance(r.get("entry"), dict) else {}
        if r.get("type") == "entry_appended" and entry.get("customType") == "pi-foreman-ceremony-gate":
            out.append(entry.get("content"))
    return out


APPROVE = {"value": "approve"}


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestCheckpoint(ReplayCase):
    def start(self, name, run=""):
        rig = self.rig(name, script(run), permissions="baseline")
        herdr = rig.root / "herdr.jsonl"
        return rig, rig.start(env={"FOREMAN_FAKE_HERDR": str(herdr)}), herdr

    def test_approve_lets_the_builder_through(self):
        rig, pi, herdr = self.start("ck-approve")
        recs = pi.prompt("[[replay:approve]] build it", answers=[APPROVE], timeout=90)
        res = tool_results(recs)
        self.assertEqual([(n, e) for n, e, _ in res], [("foreman_triage", False), ("write", False), ("subagent", True), ("write", False),
                                                      ("foreman_checkpoint", False), ("subagent", False)], res)
        self.assertIn("pi-foreman: builder launch refused [launch_refused:plan_required]: at tier heavy a builder starts only after the owner approved a plan", res[2][2])
        self.assertIn("The owner approved plan-ck.md", res[4][2])
        # the checkpoint is the only dialog: the permission baseline allows the tool without an ask
        ds = dialogs(recs)
        self.assertEqual([(d["method"], d["title"].startswith(TITLE)) for d in ds], [("select", True)], ds)
        self.assertEqual(ds[0]["options"], ["revise", "reject", "approve"], "approve is never the preselected first option")
        self.assertNotIn("timeout", ds[0])
        self.assertTrue(any("Plan: Widget" in n and "Goal: Ship the widget." in n for n in notifications(recs)), notifications(recs))
        blocked = [json.loads(line) for line in herdr.read_text("utf-8").splitlines()]
        self.assertEqual([(b["active"], b["label"].startswith(TITLE)) for b in blocked], [(True, True), (False, True)], blocked)
        pi.wait_child_notify(timeout=180)
        pi.close()
        self.assertEqual([(r["reason"], r["tier"]) for r in events(rig, "launch_refused")], [("plan_required", "heavy")])
        self.assertEqual([(r["decision"], r["by"], r["tier"]) for r in events(rig, "checkpoint")], [("approve", "rig", "heavy")])
        self.assertEqual([(r["tier"], r["by"]) for r in events(rig, "plan_written")], [("heavy", "foreman")])
        self.assertEqual([r["role"] for r in events(rig, "role_launch")], ["builder"], "the refused launch records nothing")

    def test_revise_returns_the_note_and_needs_a_new_checkpoint(self):
        rig, pi, _ = self.start("ck-revise")
        answers = [{"value": "revise"}, {"value": "split it in two steps"}, APPROVE]
        res = tool_results(pi.prompt("[[replay:revise]] build it", answers=answers, timeout=90))
        self.assertEqual([(n, e) for n, e, _ in res], [("foreman_triage", False), ("write", False), ("write", False), ("foreman_checkpoint", False),
                                                      ("subagent", True), ("edit", False), ("foreman_checkpoint", False), ("subagent", False)], res)
        self.assertIn("The owner's words:\nsplit it in two steps", res[3][2])
        self.assertIn("[launch_refused:checkpoint_pending]", res[4][2])
        self.assertIn("The owner approved plan-ck.md", res[6][2])
        pi.wait_child_notify(timeout=180)
        pi.close()
        self.assertEqual([r["decision"] for r in events(rig, "checkpoint")], ["revise", "approve"])
        self.assertEqual([r["reason"] for r in events(rig, "launch_refused")], ["checkpoint_pending"])
        self.assertEqual(len(events(rig, "plan_written")), 2)
        self.assertNotIn("two steps", json.dumps(rig.traces()), "no note text in the trace")

    def test_reject_stops_builders_and_the_finish_names_the_plan(self):
        rig, pi, _ = self.start("ck-reject")
        recs = pi.prompt("[[replay:reject]] build it", answers=[{"value": "reject"}], timeout=90)
        pi.close()
        res = tool_results(recs)
        self.assertEqual([(n, e) for n, e, _ in res], [("foreman_triage", False), ("write", False), ("write", False), ("foreman_checkpoint", False), ("subagent", True)], res)
        self.assertIn("The heavy path is stopped", res[3][2])
        self.assertIn("[launch_refused:plan_required]: the owner rejected plan-ck.md", res[4][2])
        self.assertTrue(any("plan-ck.md was rejected" in n for n in notifications(recs)), notifications(recs))
        msgs = gate_messages(recs)
        self.assertEqual(len(msgs), 2, msgs)
        self.assertIn("finish refused: tier heavy requires planner, builder, reviewer, finalizer, plan;", msgs[0])
        self.assertIn("The owner rejected the plan", msgs[0])
        self.assertEqual([r["missing"] for r in events(rig, "finish_refused")], ["planner,builder,reviewer,finalizer,plan"] * 2)
        self.assertEqual([r["missing"] for r in events(rig, "ceremony_incomplete")], ["planner,builder,reviewer,finalizer,plan"])
        self.assertEqual([r["decision"] for r in events(rig, "checkpoint")], ["reject"])

    def test_plan_edited_after_approval_is_plan_changed(self):
        rig, pi, _ = self.start("ck-changed")
        res = tool_results(pi.prompt("[[replay:changed]] build it", answers=[APPROVE], timeout=90))
        pi.close()
        self.assertEqual([(n, e) for n, e, _ in res][-2:], [("edit", False), ("subagent", True)], res)
        self.assertIn("[launch_refused:plan_changed]: plan-ck.md changed or is gone since the owner approved it", res[-1][2])
        self.assertEqual([r["reason"] for r in events(rig, "launch_refused")], ["plan_changed"])

    def test_cancelled_dialog_stays_pending(self):
        rig, pi, _ = self.start("ck-cancel")
        res = tool_results(pi.prompt("[[replay:cancel]] build it", answers=[{"cancelled": True}], timeout=90))
        pi.close()
        self.assertEqual([(n, e) for n, e, _ in res][-2:], [("foreman_checkpoint", False), ("subagent", True)], res)
        self.assertIn("stays pending — ask the owner in your reply", res[-2][2])
        self.assertIn("[launch_refused:checkpoint_pending]", res[-1][2])
        self.assertEqual([(r["decision"], r.get("by")) for r in events(rig, "checkpoint")], [("pending", None)])

    def test_no_ui_stays_pending(self):
        rig = self.rig("ck-noui", script(), permissions="baseline")
        code, recs, err = rig.run_print("[[replay:noui]] build it", timeout=90)
        res = tool_results(recs)
        self.assertEqual([(n, e) for n, e, _ in res], [("foreman_triage", False), ("write", False), ("foreman_checkpoint", False)], (res, err[-2000:]))
        self.assertIn("stays pending", res[2][2])
        self.assertEqual([r["decision"] for r in events(rig, "checkpoint")], ["pending"])

    def test_tasks_and_chain_builders_are_refused(self):
        rig, pi, _ = self.start("ck-forms")
        res = tool_results(pi.prompt("[[replay:forms]] build it", timeout=90))
        self.assertEqual([(n, e) for n, e, _ in res], [("foreman_triage", False), ("write", False), ("subagent", True), ("subagent", True), ("subagent", True), ("subagent", False)], res)
        for _, _, text in res[2:5]:
            self.assertIn("[launch_refused:plan_required]", text)
        pi.wait_child_notify(timeout=180)
        pi.close()
        self.assertEqual([r["role"] for r in events(rig, "role_launch")], ["explorer"])

    def test_resume_of_a_builder_run_is_refused_at_heavy(self):
        rig, pi, _ = self.start("ck-resume")
        recs = pi.prompt("[[replay:std]] build it", timeout=90)
        [launch] = [r for r in recs if r.get("type") == "tool_execution_end" and r.get("toolName") == "subagent"]
        details = (launch.get("result") or {}).get("details") or {}
        run = details.get("runId") or details.get("asyncId")
        self.assertTrue(run, launch)
        pi.wait_child_notify(timeout=180)
        rig.script.write_text(json.dumps(script(run), indent=1), "utf-8")
        res = tool_results(pi.prompt("[[replay:res]] go on", timeout=90))
        pi.close()
        self.assertEqual([(n, e) for n, e, _ in res], [("foreman_triage", False), ("subagent", True)], res)
        self.assertIn("[launch_refused:plan_required]", res[1][2])

    def test_without_the_baseline_allow_the_permission_system_asks(self):
        rig = self.rig("ck-perm", script(), permissions="baseline")
        cfg_file = rig.agent / "extensions" / "pi-permission-system" / "config.json"
        cfg = json.loads(cfg_file.read_text("utf-8"))
        self.assertEqual(cfg["permission"].get("foreman_checkpoint"), "allow")
        del cfg["permission"]["foreman_checkpoint"]
        cfg_file.write_text(json.dumps(cfg), "utf-8")
        pi = rig.start()
        recs = pi.prompt("[[replay:perm]] go", answers=[{"cancelled": True}], timeout=90)
        pi.close()
        res = tool_results(recs, "foreman_checkpoint")
        ds = dialogs(recs)
        self.assertTrue(ds and not ds[0].get("title", "").startswith(TITLE), ds)
        self.assertEqual([e for _, e, _ in res], [True], res)
        self.assertEqual(events(rig, "checkpoint"), [], "the permission system stopped it before the tool ran")


if __name__ == "__main__":
    unittest.main()
