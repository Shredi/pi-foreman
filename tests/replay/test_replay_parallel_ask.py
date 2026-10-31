"""Finish-gate (54c): two child launches in one tool array run in parallel; one child asks the
supervisor, the foreman answers, both children finish. Same prerequisites and skips as test_replay.py."""
from __future__ import annotations

import json
import os
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, shape, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


def settle_between_results(events):
    """Whether the foreman wakes for the first finished child before the second one lands is a
    scheduling race (slow CI runners take the extra wake, fast hosts batch both results into one),
    so the wake's llm/turn/Stop events between the two role_result events are not part of the golden."""
    res = [i for i, e in enumerate(events) if e["event"] == "role_result"]
    if len(res) < 2:
        return events
    keep = {"child_scratch", "role_result"}
    return [e for i, e in enumerate(events) if not (res[0] < i < res[-1]) or e["event"] in keep]


def is_stop(e):
    return e["event"] == "guard" and e.get("toolFamily") == "Stop"


def relocate_post_reply_stop(events):
    """The one Stop guard after the supervisor reply, placed directly before the first child_scratch after it. The reply
    wakes the child and ends the foreman's turn at the same moment, so the Stop is written concurrently with the
    children's records and may land after that child_scratch, between the two results, or after both."""
    reply = next((i for i, e in enumerate(events) if e["event"] == "supervisor_request" and e.get("decision") == "replied"), None)
    if reply is None:
        return events
    stop = next((i for i in range(reply, len(events)) if is_stop(events[i])), None)
    scratch = next((i for i in range(reply, len(events)) if events[i]["event"] == "child_scratch"), None)
    if stop is None or scratch is None or stop < scratch:
        return events
    return events[:scratch] + [events[stop]] + events[scratch:stop] + events[stop + 1:]


def split_streams(events):
    """(foreman's own records, child_scratch/role_result records). The two streams are written by different processes
    and the product promises no order between them; only each stream's own order and the causal checks are compared."""
    own = settle_between_results(relocate_post_reply_stop(events))
    child = {"child_scratch", "role_result"}
    return [e for e in own if e["event"] not in child], [e for e in own if e["event"] in child]


def causal_problems(events):
    """Order guarantees that really hold between the streams: open < replied < first child_scratch, and a Stop after the last role_result."""
    names = [(e["event"], e.get("decision")) for e in events]
    problems = []
    opened = names.index(("supervisor_request", "open")) if ("supervisor_request", "open") in names else None
    replied = names.index(("supervisor_request", "replied")) if ("supervisor_request", "replied") in names else None
    scratch = next((i for i, n in enumerate(names) if n[0] == "child_scratch"), None)
    results = [i for i, n in enumerate(names) if n[0] == "role_result"]
    if opened is None or replied is None or opened > replied:
        problems.append("supervisor open does not precede replied")
    if replied is not None and scratch is not None and scratch < replied:
        problems.append("child_scratch before the supervisor reply")
    if not results or not any(is_stop(e) for e in events[results[-1] + 1:]):
        problems.append("no Stop after the last role_result")
    return problems


def stream_problems(events, golden):
    """Everything wrong with a foreman trace against the golden: causal violations and per-stream differences."""
    problems = causal_problems(events)
    own, child = split_streams(events)
    want_own, want_child = split_streams(golden)
    if own != want_own:
        problems.append("foreman's own records differ from the golden")
    if child != want_child:
        problems.append("child_scratch/role_result records differ from the golden")
    return problems


def finished(traces, foreman_key):
    """Both children have ended (each trace's last record is a Stop guard), and the foreman has both results,
    its supervisor reply and a Stop guard after the last result."""
    foreman = traces.get(foreman_key) or []
    children = [recs for recs in traces.values() if recs and recs[0].get("role") == "child"]
    if len(children) != 2 or not all(is_stop(recs[-1]) for recs in children):
        return False
    res = [i for i, e in enumerate(foreman) if e["event"] == "role_result"]
    return (len(res) == 2 and any(e["event"] == "supervisor_request" and e.get("decision") == "replied" for e in foreman)
            and any(is_stop(e) for e in foreman[res[-1] + 1:]))


def notices_of(records):
    return [json.dumps(r["message"].get("content")) for r in records
            if r.get("type") == "message_end" and isinstance(r.get("message"), dict)
            and r["message"].get("customType") == "subagent-notify"]


def collect_notices(pi, recs, timeout=60.0):
    """Reads the RPC stream until both children's notices are in (or the timeout), so a notice still in flight is kept."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        texts = notices_of(recs)
        if any("first child finished" in n for n in texts) and any("second child finished" in n for n in texts):
            break
        recs = recs + pi.drain(0.5)
    return recs


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestParallelAsk(ReplayCase):
    def test_two_launches_one_ask(self):
        rig = self.rig("parallel-ask", load_fixture("parallel_ask"), permissions="baseline")
        pi = rig.start()
        sid = pi.session_id()
        res = tool_results(pi.prompt("[[replay:p1]] go", timeout=60), "subagent")
        self.assertEqual([e for _, e, _ in res], [False, False], res)
        _, recs = pi.wait_child_notify(timeout=120)
        # wait_child_notify returns at the first notice that settles: the other child's contact, the foreman's reply and
        # its last turn can still be running. Wait for their trace records, then read the notices still in flight.
        rig.wait_trace(lambda t: finished(t, "trace-" + sid), timeout=120)
        recs = collect_notices(pi, recs)
        pi.close()
        notices = notices_of(recs)
        self.assertTrue(any("first child finished" in n for n in notices), notices)
        self.assertTrue(any("second child finished" in n for n in notices), notices)
        t = rig.traces()
        raw = t.pop("trace-" + sid)
        # ledger item 26: both role launches are allowed by the gate default `default-role-launch`, with no review call (the golden has no review records)
        rules = [r.get("rule") for r in raw if r.get("event") == "guard" and r.get("guard") == "gate" and r.get("toolFamily") == "subagent"]
        self.assertEqual(rules, ["default-role-launch", "default-role-launch"], rules)
        foreman = shape(raw)
        children = sorted((shape(v) for v in t.values() if v and v[0].get("role") == "child"), key=repr)
        self.assertEqual(len(children), 2, "adapter did not load in both children")
        sup = [r["decision"] for r in foreman if r["event"] == "supervisor_request"]
        self.assertEqual(sup, ["open", "replied"])
        if os.environ.get("FOREMAN_REPLAY_UPDATE_GOLDEN") == "1":
            self.golden("parallel_ask", {"foreman": settle_between_results(relocate_post_reply_stop(foreman)), "children": children})
        want = json.loads((Path(__file__).resolve().parent / "golden" / "parallel_ask.json").read_text("utf-8"))
        self.assertEqual(stream_problems(foreman, want["foreman"]), [])
        self.assertEqual(children, want["children"])


class TestAllowedOrders(unittest.TestCase):
    S = {"event": "guard", "toolFamily": "Stop"}
    OPEN = {"event": "supervisor_request", "decision": "open"}
    REPLIED = {"event": "supervisor_request", "decision": "replied"}
    LLM = {"event": "llm"}
    TURN = {"event": "turn"}
    CS = {"event": "child_scratch"}
    RR = {"event": "role_result"}
    GOLDEN = [TURN, S, OPEN, REPLIED, LLM, TURN, S, CS, RR, CS, RR, TURN, S]

    def problems(self, trace):
        return stream_problems(trace, self.GOLDEN)

    def test_golden_matches_itself(self):
        self.assertEqual(self.problems(self.GOLDEN), [])

    def test_post_reply_stop_after_child_scratch_or_between_results_or_after_both_is_accepted(self):
        T, S, O, R, L, CS, RR = self.TURN, self.S, self.OPEN, self.REPLIED, self.LLM, self.CS, self.RR
        orders = {
            "after child_scratch": [T, S, O, R, L, T, CS, S, RR, CS, RR, T, S],
            "between results (observed on CI)": [T, S, O, R, L, T, CS, RR, S, CS, RR, T, S],
            "after both results": [T, S, O, R, L, T, CS, RR, CS, RR, S, T, S],
            "wake between results": [T, S, O, R, L, T, CS, RR, S, L, T, S, CS, RR, T, S],
        }
        for name, trace in orders.items():
            with self.subTest(order=name):
                self.assertEqual(self.problems(trace), [])

    def test_stop_moved_across_turn_llm_or_request_still_fails(self):
        S, T, L, O, R, CS, RR = self.S, self.TURN, self.LLM, self.OPEN, self.REPLIED, self.CS, self.RR
        moved = {
            "turn": [T, S, O, R, L, S, T, CS, RR, CS, RR, T, S],
            "llm": [T, S, O, R, S, L, T, CS, RR, CS, RR, T, S],
            "supervisor_request": [T, S, O, S, R, L, T, CS, RR, CS, RR, T, S],
        }
        for name, trace in moved.items():
            with self.subTest(moved_across=name):
                self.assertNotEqual(self.problems(trace), [])

    def test_replied_after_a_child_scratch_fails(self):
        T, S, O, R, L, CS, RR = self.TURN, self.S, self.OPEN, self.REPLIED, self.LLM, self.CS, self.RR
        self.assertIn("child_scratch before the supervisor reply",
                      self.problems([T, S, O, CS, R, L, T, S, RR, CS, RR, T, S]))

    def test_missing_stop_after_the_last_result_fails(self):
        T, S, O, R, L, CS, RR = self.TURN, self.S, self.OPEN, self.REPLIED, self.LLM, self.CS, self.RR
        self.assertIn("no Stop after the last role_result",
                      self.problems([T, S, O, R, L, T, S, CS, RR, CS, RR, T]))

    def test_missing_child_records_fail(self):
        T, S, O, R, L, CS, RR = self.TURN, self.S, self.OPEN, self.REPLIED, self.LLM, self.CS, self.RR
        self.assertNotEqual(self.problems([T, S, O, R, L, T, S, CS, RR, T, S]), [])


if __name__ == "__main__":
    unittest.main()
