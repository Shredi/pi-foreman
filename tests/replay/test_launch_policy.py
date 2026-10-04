"""Launch policy replay (plan D6, D7; ledger items 14, 15, 25): subagent actions and the
supervisor channel on the fake provider. Run: python -m unittest discover -s tests/replay -v"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results  # noqa: E402
from test_replay import ReplayCase  # noqa: E402


def wait_records(pi, done, timeout):
    """Collect RPC records until done(record, collected) is true."""
    deadline = time.time() + timeout
    out = []
    while True:
        rec = pi._next(deadline)
        out.append(rec)
        if done(rec, out):
            return out


def is_request(rec):
    msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
    return rec.get("type") == "message_end" and msg.get("customType") == "subagent_supervisor_request"


class TestLaunchPolicy(ReplayCase):
    def test_resume_unknown_run_and_workflow_blocked(self):
        rig = self.rig("actions", load_fixture("launch_policy"))
        pi = rig.start()
        res = tool_results(pi.prompt("[[replay:p1]] start", timeout=60), "subagent")
        self.assertEqual([e for _, e, _ in res], [True, True])
        self.assertIn("pi-foreman: resume blocked: run 'run-from-elsewhere' was not launched by this session; launch a fresh <role> instead.", res[0][2])
        self.assertIn("pi-foreman: workflow scripts can launch any agent with any model", res[1][2])
        pi.close()

    def test_supervisor_request_limits_foreman_tools(self):
        rig = self.rig("supervisor", load_fixture("launch_policy"))
        pi = rig.start()
        sid = pi.session_id()
        [(_, err, text)] = tool_results(pi.prompt("[[replay:s1]] start", timeout=60), "subagent")
        self.assertFalse(err, text)
        # The explorer asks the foreman to write a file; the request opens a window in which
        # `write` (not an explorer tool) is blocked, and the reply closes it.
        seen = {"request": False}

        def done(rec, _out):
            if is_request(rec):
                seen["request"] = True
            return seen["request"] and rec.get("type") == "agent_settled"

        recs = wait_records(pi, done, 120)
        res = tool_results(recs)
        self.assertEqual([(n, e) for n, e, _ in res], [("write", True), ("subagent_supervisor", False)], res)
        self.assertIn("a supervisor request from a child of role explorer is open, and write is not in the explorer role's tools", res[0][2])
        self.assertFalse((rig.project / "notes.txt").exists())
        notice, _ = pi.wait_child_notify(timeout=90)
        self.assertIn("explorer child result", notice)
        pi.close()
        sup = [(r["role"], r["decision"]) for r in rig.traces()["trace-" + sid] if r.get("event") == "supervisor_request"]
        self.assertEqual(sup, [("explorer", "open"), ("explorer", "blocked_tool"), ("explorer", "replied")])
