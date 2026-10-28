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


def stop_after_child_scratch(golden):
    """The golden foreman list with the one post-reply Stop guard moved to directly after the child_scratch that follows it."""
    reply = next(i for i, e in enumerate(golden) if e["event"] == "supervisor_request" and e.get("decision") == "replied")
    stop = next(i for i in range(reply, len(golden)) if is_stop(golden[i]))
    scratch = next(i for i in range(stop, len(golden)) if golden[i]["event"] == "child_scratch")
    assert not any(is_stop(e) or e["event"] == "child_scratch" for e in golden[reply:stop]), "unexpected golden shape"
    return golden[:stop] + golden[stop + 1:scratch + 1] + [golden[stop]] + golden[scratch + 1:]


def allowed_foreman_orders(golden):
    """The two orderings the foreman trace may have. The supervisor reply wakes the child and ends the foreman's turn
    at the same moment, so the foreman's Stop guard and the child's child_scratch are written concurrently; both
    orders are correct behaviour: (a) the golden as is, (b) the Stop guard right after the child_scratch."""
    return [golden, stop_after_child_scratch(golden)]


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
        foreman = settle_between_results(shape(raw))
        children = sorted((shape(v) for v in t.values() if v and v[0].get("role") == "child"), key=repr)
        self.assertEqual(len(children), 2, "adapter did not load in both children")
        sup = [r["decision"] for r in foreman if r["event"] == "supervisor_request"]
        self.assertEqual(sup, ["open", "replied"])
        if os.environ.get("FOREMAN_REPLAY_UPDATE_GOLDEN") == "1":
            self.golden("parallel_ask", {"foreman": foreman, "children": children})
        want = json.loads((Path(__file__).resolve().parent / "golden" / "parallel_ask.json").read_text("utf-8"))
        self.assertIn(foreman, allowed_foreman_orders(want["foreman"]))
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

    def test_variant_moves_only_the_post_reply_stop(self):
        want = [self.TURN, self.S, self.OPEN, self.REPLIED, self.LLM, self.TURN, self.CS, self.S, self.RR, self.CS, self.RR, self.TURN, self.S]
        self.assertEqual(stop_after_child_scratch(self.GOLDEN), want)

    def test_golden_matches_first_ordering(self):
        self.assertEqual(allowed_foreman_orders(self.GOLDEN)[0], self.GOLDEN)

    def test_stop_moved_across_turn_llm_or_request_matches_neither(self):
        S, T, L, O, R = self.S, self.TURN, self.LLM, self.OPEN, self.REPLIED
        moved = {
            "turn": [T, S, O, R, L, S, T, self.CS, self.RR, self.CS, self.RR, T, S],
            "llm": [T, S, O, R, S, L, T, self.CS, self.RR, self.CS, self.RR, T, S],
            "supervisor_request": [T, S, O, S, R, L, T, self.CS, self.RR, self.CS, self.RR, T, S],
        }
        for name, trace in moved.items():
            with self.subTest(moved_across=name):
                self.assertNotIn(trace, allowed_foreman_orders(self.GOLDEN))


if __name__ == "__main__":
    unittest.main()
