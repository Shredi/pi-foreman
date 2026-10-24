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


def canonical_span(events):
    """From the `replied` supervisor_request to the last role_result, the Stop guards move after the other
    events of that span. Whether the supervisor-reply wake's Stop guard lands before or after the first child's
    child_scratch is a race (the wake and the child's last writes run concurrently), so both the actual trace and
    the golden are canonicalised the same way. The multiset of events, the Stop count and each child's
    child_scratch -> role_result order are kept; events outside the span are untouched."""
    start = next((i for i, e in enumerate(events) if e["event"] == "supervisor_request" and e.get("decision") == "replied"), None)
    res = [i for i, e in enumerate(events) if e["event"] == "role_result"]
    if start is None or not res or res[-1] < start:
        return events
    end = res[-1] + 1
    span = events[start:end]
    return events[:start] + [e for e in span if not is_stop(e)] + [e for e in span if is_stop(e)] + events[end:]


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
        foreman = settle_between_results(shape(t.pop("trace-" + sid)))
        children = sorted((shape(v) for v in t.values() if v and v[0].get("role") == "child"), key=repr)
        self.assertEqual(len(children), 2, "adapter did not load in both children")
        sup = [r["decision"] for r in foreman if r["event"] == "supervisor_request"]
        self.assertEqual(sup, ["open", "replied"])
        if os.environ.get("FOREMAN_REPLAY_UPDATE_GOLDEN") == "1":
            self.golden("parallel_ask", {"foreman": foreman, "children": children})
        want = json.loads((Path(__file__).resolve().parent / "golden" / "parallel_ask.json").read_text("utf-8"))
        self.assertEqual(canonical_span(foreman), canonical_span(want["foreman"]))
        self.assertEqual(children, want["children"])


class TestCanonicalSpan(unittest.TestCase):
    S = {"event": "guard", "toolFamily": "Stop"}
    OPEN = {"event": "supervisor_request", "decision": "open"}
    REPLIED = {"event": "supervisor_request", "decision": "replied"}
    CS = {"event": "child_scratch"}
    RR = {"event": "role_result"}
    EV = [{"event": "turn"}, S, OPEN, REPLIED, {"event": "turn"}, S, CS, RR, {"event": "turn"}, S]

    def test_no_reply_unchanged(self):
        ev = [e for e in self.EV if e is not self.REPLIED]
        self.assertEqual(canonical_span(ev), ev)

    def test_span_stop_guards_move_after_the_other_span_events(self):
        want = [{"event": "turn"}, self.S, self.OPEN, self.REPLIED, {"event": "turn"}, self.CS, self.RR, self.S, {"event": "turn"}, self.S]
        self.assertEqual(canonical_span(self.EV), want)

    def test_multiset_stop_count_and_child_order_kept(self):
        got = canonical_span(self.EV)
        self.assertEqual(sorted(map(repr, got)), sorted(map(repr, self.EV)))
        self.assertEqual(sum(is_stop(e) for e in got), 3)
        self.assertLess(got.index(self.CS), got.index(self.RR))

    def test_two_children_order_kept(self):
        ev = [self.REPLIED, self.CS, self.S, self.RR, self.CS, self.RR]
        self.assertEqual(canonical_span(ev), [self.REPLIED, self.CS, self.RR, self.CS, self.RR, self.S])


if __name__ == "__main__":
    unittest.main()
