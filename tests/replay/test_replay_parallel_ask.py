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
    """On win32 (slow runner) the Stop guard of the supervisor-reply wake lands after the first
    role_result instead of before it, so only the final Stop guard is kept there (applied to the
    actual trace and to the golden alike; POSIX is untouched)."""
    if not win32:
        return events
    stops = [i for i, e in enumerate(events) if e["event"] == "guard" and e.get("toolFamily") == "Stop"]
    drop = set(stops[:-1])
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
    EV = [{"event": "turn"}, {"event": "guard", "toolFamily": "Stop"}, {"event": "role_result"},
          {"event": "guard", "toolFamily": "Stop"}]

    def test_posix_unchanged(self):
        self.assertEqual(drop_wake_stops(self.EV, False), self.EV)

    def test_win32_keeps_only_final_stop(self):
        self.assertEqual(drop_wake_stops(self.EV, True), [self.EV[0], self.EV[2], self.EV[3]])


if __name__ == "__main__":
    unittest.main()
