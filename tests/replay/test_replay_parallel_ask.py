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
        foreman = shape(t.pop("trace-" + sid))
        children = sorted((shape(v) for v in t.values() if v and v[0].get("role") == "child"), key=repr)
        self.assertEqual(len(children), 2, "adapter did not load in both children")
        sup = [r["decision"] for r in foreman if r["event"] == "supervisor_request"]
        self.assertEqual(sup, ["open", "replied"])
        self.golden("parallel_ask", {"foreman": foreman, "children": children})


if __name__ == "__main__":
    unittest.main()
