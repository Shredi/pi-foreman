"""Replay: child orchestrator sessions (ledger items 6 and 7): parent -> child -> result, and a dry-run open on a higher tier.

The parent waits with `foreman_wait kind child`; the child (a second session with a handoff dir whose
`parent` file names the parent) sends `Plan from demo: <path>` and later `Result from demo: <path>` over
intercom; each message starts a parent turn and ends the parent's wait with one quiet `foreman_wait_note` line
(`ended by the notice above: child demo: plan ...`, then `... result ...`), no `foreman_wake`. After a `Plan from` one fixed
`demo waits for: ...` line follows (customType `pi-foreman-child-blocked`, from the child's round state; here a standard tier with no
review yet); a `Result from` gets no such line. A
`/foreman session open ... --dry-run --model <higher tier>` in the parent opens (no rank rule, no confirm window on a dry run).
Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results
from test_replay import REASON, ReplayCase
from test_replay_session_close import drain_until

CHILD = "fm-demo-abc123"
RANKS = [{"match": "elite", "tier": 0}, {"match": "foreman", "tier": 1}]


def custom_messages(records):
    """The custom messages that were appended, each once (message_start)."""
    return [r["message"] for r in records if r.get("type") == "message_start" and r["message"].get("role") == "custom"]


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestSessionTree(ReplayCase):
    def test_child_plan_and_result_wake_the_parent_and_a_higher_tier_dry_run_opens(self):
        config = {"wait": {"batchWindowSeconds": 0}, "sync": {"runRetro": False},
                  "providers": {"foreman-fake": {"ranks": RANKS}}}
        rig = self.rig("sesstree", load_fixture("session_tree"), config=config, intercom=True)
        handoff = rig.root / "handoff"
        handoff.mkdir()
        (handoff / "parent").write_text("parent-x\n", "utf-8")
        (rig.project / "brief.md").write_text("# Task\n\nDo the thing.\n", "utf-8")
        rig.state_dir.mkdir(parents=True, exist_ok=True)
        (rig.state_dir / "sessions.json").write_text(json.dumps({"version": 1, "sessions": [
            {"label": "demo", "child": CHILD, "parent": "parent-x", "handoff": str(handoff), "status": "open"}]}), "utf-8")
        child = rig.start(env={"PI_FOREMAN_HANDOFF_DIR": str(handoff), "PI_INTERCOM_STABLE_ID": CHILD})
        child.prompt("[[replay:w1]] wait", timeout=90)
        parent = rig.start(env={"PI_INTERCOM_STABLE_ID": "parent-x"})
        psid = parent.session_id()

        res = tool_results(parent.prompt("[[replay:p1]] wait for the child", timeout=90))
        self.assertEqual([(n, e) for n, e, _ in res], [("foreman_wait", False)], res)

        child.prompt("[[replay:c1]] send the plan", timeout=90)
        # The notice arrives as an intercom message that starts the turn; the wait ends with one quiet line, no wake.
        seen = drain_until(parent, "ended by the notice above: child demo: plan", 40)
        self.assertIn("ended by the notice above: child demo: plan .workflow/plan-demo.md", json.dumps(seen))
        seen += drain_until(parent, "agent_settled", 30)
        notes = custom_messages(seen)
        self.assertEqual([m.get("customType") for m in notes], ["intercom_message", "foreman_wait_note", "pi-foreman-child-blocked"], "one quiet line and one wait line, no foreman_wake")
        # the replay child's round-state.json says tier standard, no review passed, plan open: it goes on to build after its own review
        self.assertIn("demo waits for: its own plan review, then it goes on to build; nothing from you.", json.dumps(notes[2]))

        parent.prompt("[[replay:p2]] wait for the result", timeout=90)  # the intercom turn did not start the second wait
        child.prompt("[[replay:c2]] send the result", timeout=90)
        seen = drain_until(parent, "ended by the notice above: child demo: result", 40)
        self.assertIn("ended by the notice above: child demo: result .workflow/result-demo.md", json.dumps(seen))
        seen += drain_until(parent, "agent_settled", 30)
        types = [m.get("customType") for m in custom_messages(seen)]
        self.assertNotIn("foreman_wake", types)
        self.assertNotIn("pi-foreman-child-blocked", types, "a Result from gets no wait line")

        # No rank rule: a tier 0 model opens from a tier 1 parent; a dry run shows no confirm window.
        seen = parent.prompt("/foreman session open demo2 brief.md --dry-run --model foreman-fake/elite", timeout=30)
        self.assertNotIn("session open refused", json.dumps(seen))

        safe = "".join(c for c in psid if c.isalnum() or c in "-_")
        trace = rig.traces()["trace-" + safe]
        waits = [(r["decision"], r.get("toolFamily")) for r in trace if r.get("event") == "wait"]
        self.assertEqual(waits, [("start", "child"), ("taken", "child"), ("start", "child"), ("taken", "child")], waits)
        self.golden("session_tree", {"parent": [{k: r[k] for k in ("event", "decision", "toolFamily", "wakeKinds", "cause") if k in r}
                                                for r in trace if r.get("event") in ("wait", "turn")]})
