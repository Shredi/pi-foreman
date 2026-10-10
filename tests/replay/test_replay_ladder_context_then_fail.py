"""Replay: a context climb, then a reviewer FAIL on the strong rung (live rung, no stale climb).

The builder maps `foreman-fake/builder` (bottom) -> strong `foreman-fake/finalizer`, strongAbove
1000. The bottom-rung builder hands off (`RUNG_UP: context`), the foreman relaunches it on
`strong` (one `rung_up` from the bottom, reason context). The reviewer FAILs; the revision builder
starts from the live rung, which already is the strong one: `rung_top`, no second `rung_up` from
the bottom rung. The re-review FAILs; the finish gate offers no climb (`climb_available` unset) and
the two-refusal valve ends with `ceremony_incomplete`.
Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import PROVIDER_A, load_fixture  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402
from test_replay_review_flow import usage  # noqa: E402

CONFIG = {"providers": {PROVIDER_A: {"strongAbove": 1000, "roles": {"builder": {"strong": {"model": "%s/finalizer" % PROVIDER_A}}}}}}


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestLadderContextThenFail(ReplayCase):
    def test_one_climb_then_rung_top_and_the_valve(self):
        rig = self.rig("ladder-context-then-fail", load_fixture("ladder_context_then_fail"), config=CONFIG)
        (rig.project / "a.txt").write_text("alpha\n", "utf-8")
        pi = rig.start()
        sid = pi.session_id()
        recs = pi.prompt("[[replay:c1]] build it", timeout=60)
        for _ in range(5):
            recs += pi.wait_child_notify(timeout=180)[1]
        pi.close()

        safe = "".join(c for c in sid if c.isalnum() or c in "-_")
        trace = rig.traces()["trace-" + safe]
        kinds = [r["event"] for r in trace if r.get("event") in ("rung_up", "rung_top", "finish_refused", "ceremony_incomplete")]
        self.assertEqual(kinds, ["rung_up", "rung_top", "finish_refused", "finish_refused", "ceremony_incomplete"])
        [up] = [r for r in trace if r.get("event") == "rung_up"]
        self.assertEqual((up["role"], up["from"], up["to"], up["reason"]),
                         ("builder", "%s/builder" % PROVIDER_A, "%s/finalizer" % PROVIDER_A, "context"))
        [top] = [r for r in trace if r.get("event") == "rung_top"]
        self.assertEqual((top["role"], top["model"], top["reason"]), ("builder", "%s/finalizer" % PROVIDER_A, "review_fail"))
        refused = [r for r in trace if r.get("event") == "finish_refused"]
        self.assertEqual([r.get("climb_available") for r in refused], [None, None])
        builders = [(x.get("kind"), x["model"]) for x in usage(rig, sid) if x["role"] == "builder"]
        self.assertEqual(builders, [("first", "builder")] * 2 + [("strong-relaunch", "finalizer")] * 2)  # one usage line per call


if __name__ == "__main__":
    unittest.main()
