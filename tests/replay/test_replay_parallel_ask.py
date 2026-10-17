"""Finish-gate (54c): two child launches in one tool array run in parallel; one child asks the
supervisor, the foreman answers, both children finish. Same prerequisites and skips as test_replay.py."""
from __future__ import annotations

import json
import sys
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


def drop_wake_stops(events, win32):
    """On win32 (slow runner) the Stop guard of the supervisor-reply wake moves between the two
    role_result events, where settle_between_results masks it. So on win32 only the Stop guards
    between the `replied` supervisor_request and the first child_scratch/role_result are dropped
    (from the actual trace and the golden alike); the first-turn and final Stops stay compared.
    POSIX is untouched."""
    if not win32:
        return events
    start = next((i for i, e in enumerate(events)
                  if e["event"] == "supervisor_request" and e.get("decision") == "replied"), None)
    if start is None:
        return events
    end = next((i for i in range(start, len(events)) if events[i]["event"] in ("child_scratch", "role_result")),
               len(events))
    drop = {i for i in range(start, end)
            if events[i]["event"] == "guard" and events[i].get("toolFamily") == "Stop"}
    return [e for i, e in enumerate(events) if i not in drop]


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestParallelAsk(ReplayCase):
    def test_two_launches_one_ask(self):
        rig = self.rig("parallel-ask", load_fixture("parallel_ask"), permissions="baseline")
        pi = rig.start()
        sid = pi.session_id()
        res = tool_results(pi.prompt("[[replay:p1]] go", timeout=60), "subagent")
        self.assertEqual([e for _, e, _ in res], [False, False], res)
        _, recs = pi.wait_child_notify(timeout=120)
        recs = recs + pi.drain(15)
        pi.close()
        notices = [json.dumps(r["message"].get("content")) for r in recs
                   if r.get("type") == "message_end" and isinstance(r.get("message"), dict)
                   and r["message"].get("customType") == "subagent-notify"]
        self.assertTrue(any("first child finished" in n for n in notices), notices)
        self.assertTrue(any("second child finished" in n for n in notices), notices)
        t = rig.traces()
        foreman = settle_between_results(shape(t.pop("trace-" + sid)))
        children = sorted((shape(v) for v in t.values() if v and v[0].get("role") == "child"), key=repr)
        self.assertEqual(len(children), 2, "adapter did not load in both children")
        sup = [r["decision"] for r in foreman if r["event"] == "supervisor_request"]
        self.assertEqual(sup, ["open", "replied"])
        if sys.platform != "win32":
            self.golden("parallel_ask", {"foreman": foreman, "children": children})
            return
        want = json.loads((Path(__file__).resolve().parent / "golden" / "parallel_ask.json").read_text("utf-8"))
        self.assertEqual(drop_wake_stops(foreman, True), drop_wake_stops(want["foreman"], True))
        self.assertEqual(children, want["children"])


class TestDropWakeStops(unittest.TestCase):
    S = {"event": "guard", "toolFamily": "Stop"}
    EV = [{"event": "turn"}, S, {"event": "supervisor_request", "decision": "open"},
          {"event": "supervisor_request", "decision": "replied"}, {"event": "turn"}, S,
          {"event": "child_scratch"}, {"event": "role_result"}, {"event": "turn"}, S]

    def test_posix_unchanged(self):
        self.assertEqual(drop_wake_stops(self.EV, False), self.EV)

    def test_win32_drops_only_reply_wake_stop(self):
        want = [e for i, e in enumerate(self.EV) if i != 5]
        self.assertEqual(drop_wake_stops(self.EV, True), want)
        self.assertEqual(sum(e is self.S for e in want), 2)


if __name__ == "__main__":
    unittest.main()
