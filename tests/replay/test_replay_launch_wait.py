"""Replay: launch-wait (knob 3), completion-notice dedupe (knob 5a) and the codemode trace flag
(knob 4) on the fake provider.

A held launch returns the child's outcome in the launch turn (no bg_wait turn); a supervisor
request, wait.maxSeconds and an abort end the hold with their own text; two launches of one
message run at the same time; the notice that repeats a delivered result reaches the model as a
stub, and every earlier request is a byte-identical prefix of the later ones; launchWait
"detach" keeps the old behaviour; an explorer codemode script still runs on Pi 1.0.4 (frozen
built-ins). Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import json
import re
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

BLOCK = {"ceremony": {"launchWait": "block"}}
ENDED = re.compile(r"pi-foreman launch-wait: run (\S+) \((\w[\w-]*)\) ended completed after \d+s\. Result path: (.+?)\. No bg_wait")


def events(rig, sid, name):
    safe = "".join(c for c in sid if c.isalnum() or c in "-_")
    return [r for r in rig.traces().get("trace-" + safe, []) if r.get("event") == name]


def notices(records):
    out = []
    for r in records:
        msg = r.get("message") if isinstance(r.get("message"), dict) else {}
        if r.get("type") == "message_end" and msg.get("customType") == "subagent-notify":
            out.append(msg.get("content") if isinstance(msg.get("content"), str) else json.dumps(msg.get("content")))
    return out


def collect(pi, done, timeout):
    """RPC records until done(record) is true."""
    deadline = time.time() + timeout
    out = []
    while True:
        rec = pi._next(deadline)
        out.append(rec)
        if done(rec):
            return out


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestLaunchWait(ReplayCase):
    def test_launch_returns_outcome_notice_deduped_prefix_stable(self):
        rig = self.rig("lw-one", load_fixture("launch_wait"), config=BLOCK)
        log = rig.root / "requests.jsonl"
        pi = rig.start(env={"FOREMAN_FAKE_REQUESTS": str(log)})
        sid = pi.session_id()
        recs = pi.prompt("[[replay:one]] map it", timeout=120)
        res = tool_results(recs)
        self.assertEqual([(n, e) for n, e, _ in res], [("subagent", False)], res)
        hit = ENDED.search(res[0][2])
        self.assertIsNotNone(hit, res[0][2])
        run_id, role, path = hit.groups()
        self.assertEqual(role, "explorer")
        self.assertIn("explorer child result\nsecond line of the report", res[0][2])
        [lw] = events(rig, sid, "launch_wait")
        self.assertEqual((lw["runId"], lw["outcome"], lw["role"]), (run_id, "done", "explorer"))
        # The notice still reaches the session, but the model gets a one-line stub for it.
        [full] = notices(recs)
        self.assertIn("second line of the report", full)
        pi.prompt("[[replay:again]] anything else?", timeout=60)
        pi.close()
        reqs = [json.loads(line) for line in log.read_text("utf-8").splitlines() if line.strip()]
        self.assertEqual(len(reqs), 3, "launch turn, the turn after the held result, the next prompt")
        stub = "Background task completed: **explorer** [pi-foreman: notice shortened, the result of run %s was already delivered above. Retention-managed async directory: %s]" % (run_id, path)
        texts = [json.dumps(m) for m in reqs[1]]
        self.assertTrue(any(json.dumps(stub)[1:-1] in t for t in texts), texts[-2:])
        self.assertFalse(any("second line of the report" in t and "subagent-notify" in t for t in texts))
        self.assertEqual(sum("notice shortened" in t for t in texts), 1)
        # Cache prefix: each earlier request is byte-identical (canonical JSON; Pi may reorder the
        # keys of its system message object) at the head of every later one.
        for i in range(len(reqs) - 1):
            n = len(reqs[i])
            self.assertEqual(json.dumps(reqs[i + 1][:n], sort_keys=True), json.dumps(reqs[i], sort_keys=True), "request %d changed under request %d" % (i, i + 1))
        self.assertEqual([r["runId"] for r in events(rig, sid, "notify_deduped")], [run_id], "traced once per run")

    def test_supervisor_request_ends_the_wait(self):
        rig = self.rig("lw-sup", load_fixture("launch_wait"), config=BLOCK)
        pi = rig.start()
        sid = pi.session_id()
        recs = pi.prompt("[[replay:sup]] map it", timeout=120)
        res = tool_results(recs)
        self.assertEqual([(n, e) for n, e, _ in res], [("subagent", False), ("subagent_supervisor", False)], res)
        m = re.search(r"run (\S+) \(explorer\) is still running and the child asks you something \(the supervisor request follows\)\. Answer it with subagent_supervisor, then bg_wait (\S+)\.", res[0][2])
        self.assertIsNotNone(m, res[0][2])
        self.assertEqual(m.group(1), m.group(2))
        [lw] = events(rig, sid, "launch_wait")
        self.assertEqual((lw["runId"], lw["outcome"]), (m.group(1), "supervisor"))
        notice, _ = pi.wait_child_notify(timeout=120)
        self.assertIn("explorer went on", notice)
        pi.close()

    def test_max_seconds_timeout_says_how_to_continue(self):
        rig = self.rig("lw-timeout", load_fixture("launch_wait"), config=dict(BLOCK, wait={"maxSeconds": 1}))
        pi = rig.start()
        sid = pi.session_id()
        res = tool_results(pi.prompt("[[replay:slow]] build it", timeout=120))
        self.assertEqual([(n, e) for n, e, _ in res], [("subagent", False)], res)
        m = re.search(r"run (\S+) \(builder\) is still running after 1s \(wait\.maxSeconds\); this is not a failure\. Continue with bg_wait (\S+)\.", res[0][2])
        self.assertIsNotNone(m, res[0][2])
        self.assertEqual(m.group(1), m.group(2))
        self.assertEqual([r["outcome"] for r in events(rig, sid, "launch_wait")], ["timeout"])
        notice, _ = pi.wait_child_notify(timeout=120)
        self.assertIn("Background task completed: **builder**", notice)
        pi.close()

    def test_abort_ends_the_held_call_and_the_child_keeps_running(self):
        rig = self.rig("lw-abort", load_fixture("launch_wait"), config=BLOCK)
        pi = rig.start()
        sid = pi.session_id()
        pi.send({"id": pi.next_id(), "type": "prompt", "message": "[[replay:slow]] build it"})
        # The launch result is held once role_result is traced (it is emitted just before the hold).
        recs = collect(pi, lambda r: r.get("type") == "tool_execution_start" and r.get("toolName") == "subagent", 60)
        rig.wait_trace(lambda t: any(r.get("event") == "role_result" for r in t.get("trace-" + sid, [])), timeout=30)
        time.sleep(0.5)
        t0 = time.time()
        pi.send({"id": pi.next_id(), "type": "abort"})
        recs += collect(pi, lambda r: r.get("type") == "agent_settled", 30)
        self.assertLess(time.time() - t0, 5, "the held call ends at once")
        res = tool_results(recs)
        self.assertEqual([n for n, _, _ in res], ["subagent"], res)
        m = re.search(r"the wait was cancelled; run (\S+) \(builder\) keeps running detached and its completion notice will follow\. Result path: (.+)\.", res[0][2])
        self.assertIsNotNone(m, res[0][2])
        self.assertTrue(m.group(2).endswith(m.group(1)), m.group(2))
        [lw] = events(rig, sid, "launch_wait")
        self.assertEqual((lw["runId"], lw["outcome"]), (m.group(1), "abort"))
        self.assertLess(lw["ms"], 5000)
        notice, _ = pi.wait_child_notify(timeout=120)
        self.assertIn("Background task completed: **builder**", notice)
        pi.close()

    def test_two_launches_in_one_message_run_together(self):
        rig = self.rig("lw-two", load_fixture("launch_wait"), config=BLOCK)
        pi = rig.start()
        sid = pi.session_id()
        res = tool_results(pi.prompt("[[replay:two]] split it", timeout=120))
        pi.close()
        self.assertEqual([(n, e) for n, e, _ in res], [("subagent", False), ("subagent", False)], res)
        self.assertEqual(sorted(ENDED.search(t).group(2) for _, _, t in res), ["builder", "explorer"])
        waits = events(rig, sid, "launch_wait")
        self.assertEqual([w["outcome"] for w in waits], ["done", "done"])
        starts = sorted(recs[0]["ts"] for name, recs in rig.traces().items() if recs and recs[0].get("event") == "session_start" and recs[0].get("role") == "child")
        self.assertEqual(len(starts), 2)
        self.assertLess(starts[1], min(w["ts"] for w in waits), "the second child started before the first wait ended")

    def test_detach_keeps_todays_behaviour(self):
        rig = self.rig("lw-detach", load_fixture("launch_wait"), config={"ceremony": {"launchWait": "detach"}})
        pi = rig.start()
        sid = pi.session_id()
        res = tool_results(pi.prompt("[[replay:one]] map it", timeout=120))
        self.assertEqual([(n, e) for n, e, _ in res], [("subagent", False)], res)
        self.assertNotIn("launch-wait", res[0][2])
        notice, _ = pi.wait_child_notify(timeout=120)
        pi.close()
        self.assertIn("second line of the report", notice)
        self.assertEqual(events(rig, sid, "launch_wait"), [])
        self.assertEqual(events(rig, sid, "notify_deduped"), [])

    def test_codemode_turns_traced_and_explorer_script_runs(self):
        rig = self.rig("lw-code", load_fixture("launch_wait"), config=BLOCK)
        (rig.project / "a.txt").write_text("alpha\n", "utf-8")
        pi = rig.start()
        sid = pi.session_id()
        recs = pi.prompt("[[replay:code]] map it", timeout=120)
        pi.close()
        res = tool_results(recs)
        self.assertEqual([(n, e) for n, e, _ in res], [("read", False), ("codemode", False), ("subagent", False)], res)
        self.assertIn("read true", res[1][2])
        self.assertIsNotNone(ENDED.search(res[2][2]), res[2][2])
        llm = events(rig, sid, "llm")
        self.assertEqual([r.get("codemode") for r in llm], [True, None, None])
        self.assertTrue(all(r.get("codemode") for r in events(rig, sid, "turn")))
        # The explorer's own script: built-ins are frozen, so the toJSON patch has no effect.
        [full] = notices(recs)
        session = Path(re.search(r"^Session file: (.+)$", full, re.M).group(1).strip())
        results = []
        for line in session.read_text("utf-8").splitlines():
            msg = json.loads(line).get("message") or {}
            if msg.get("role") == "toolResult" and msg.get("toolName") == "codemode":
                results.append((msg.get("isError"), "".join(c.get("text", "") for c in msg.get("content") or [])))
        self.assertEqual(len(results), 1, results)
        self.assertFalse(results[0][0], results)
        self.assertIn("codemode-ok [1]", results[0][1])


if __name__ == "__main__":
    unittest.main()
