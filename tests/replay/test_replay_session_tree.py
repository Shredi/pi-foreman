"""Replay: child orchestrator sessions (ledger items 6 and 7): parent -> child -> result, and the rank policy.

The parent waits with `foreman_wait kind child`; the child (a second session with a handoff dir whose
`parent` file names the parent) sends `Plan from demo: <path>` and later `Result from demo: <path>` over
intercom; the parent's wait wakes it with `child demo: plan ...` and then `child demo: result ...`. A
`/foreman session open ... --dry-run --model <higher tier>` in the parent is refused with `[session_rank]`.
Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402
from test_replay_session_close import drain_until  # noqa: E402

CHILD = "fm-demo-abc123"
RANKS = [{"match": "elite", "tier": 0}, {"match": "foreman", "tier": 1}]


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestSessionTree(ReplayCase):
    def test_child_plan_and_result_wake_the_parent_and_rank_is_enforced(self):
        config = {"wait": {"batchWindowSeconds": 0}, "sync": {"runRetro": False},
                  "providers": {"foreman-fake": {"ranks": RANKS}}}
        rig = self.rig("sesstree", load_fixture("session_tree"), config=config, permissions="baseline", intercom=True)
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
        seen = drain_until(parent, "child demo: plan", 40)
        self.assertIn("child demo: plan .workflow/plan-demo.md", json.dumps(seen))
        drain_until(parent, "Plan seen", 30)  # the wake turn starts the second wait

        child.prompt("[[replay:c2]] send the result", timeout=90)
        seen = drain_until(parent, "child demo: result", 40)
        self.assertIn("child demo: result .workflow/result-demo.md", json.dumps(seen))
        drain_until(parent, "Result seen", 30)

        # Rank policy: the parent session is tier 1; a tier 0 model is refused before anything is spawned.
        seen = parent.prompt("/foreman session open demo2 brief.md --dry-run --model foreman-fake/elite", timeout=30)
        self.assertIn("session open refused [session_rank]", json.dumps(seen))

        safe = "".join(c for c in psid if c.isalnum() or c in "-_")
        trace = rig.traces()["trace-" + safe]
        waits = [(r["decision"], r.get("toolFamily")) for r in trace if r.get("event") == "wait"]
        self.assertEqual(waits[:2], [("start", "child"), ("resolved", "child")], waits)
        self.assertEqual([r.get("wakeKinds") for r in trace if r.get("event") == "wait" and r["decision"] == "wake"][:2], ["child", "child"])
        self.golden("session_tree", {"parent": [{k: r[k] for k in ("event", "decision", "toolFamily", "wakeKinds", "cause") if k in r}
                                                for r in trace if r.get("event") in ("wait", "turn")]})
