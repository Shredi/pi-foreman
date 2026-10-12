"""Replay: self-planning at heavy (`ceremony.planner: self`, the default) on the fake provider.

The foreman writes `.workflow/scratch/plan-<topic>.md` itself and launches no planner. One `[plan-review]`
reviewer run opens the checkpoint; an appended `## Ruling` section is outside the plan version, so it triggers no
second review, the approval stands and the builder launch is allowed (trace `plan_version`: the body hash stays,
the bytes hash moves). With the review cap of 2, two FAILs on two plan versions open the checkpoint with the
open findings. Goldens keep the plan events only. Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, notifications, shape, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402
from test_replay_ceremony_gate import events  # noqa: E402

APPROVE = {"value": "approve"}
PLAN_EVENTS = ("role_launch", "plan_review", "checkpoint", "plan_version", "launch_refused")
CONFIG = {"ceremony": {"planReview": {"heavy": True}}}


def plan_shape(rig, sid):
    safe = "".join(c for c in sid if c.isalnum() or c in "-_")
    return shape([r for r in rig.traces()["trace-" + safe] if r.get("event") in PLAN_EVENTS])


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestPlanSelf(ReplayCase):
    def test_foreman_plan_one_review_ruling_append_builder_allowed(self):
        rig = self.rig("ps-self", load_fixture("plan_self"), config=CONFIG)
        pi = rig.start()
        sid = pi.session_id()
        res = tool_results(pi.prompt("[[replay:s1]] build it", timeout=60))
        self.assertEqual([(n, e) for n, e, _ in res][-2:], [("foreman_checkpoint", True), ("subagent", False)], res)
        self.assertIn("refused [plan_review_required]", res[-2][2])
        _, recs = pi.wait_child_notify(timeout=180, answers=[APPROVE])
        res = tool_results(recs)
        self.assertEqual([(n, e) for n, e, _ in res][:4], [("foreman_checkpoint", False), ("edit", False), ("foreman_checkpoint", False), ("subagent", False)], res)
        self.assertIn("The owner approved plan-ps.md", res[0][2])
        self.assertIn("already approved by the owner", res[2][2], "the ruling append neither re-triggers review nor resets the approval")
        pi.wait_child_notify(timeout=180)
        pi.close()
        self.assertEqual([r["role"] for r in events(rig, sid, "role_launch")], ["reviewer", "builder"], "one plan-review launch, no planner")
        self.assertEqual([(r["decision"], r.get("reason")) for r in events(rig, sid, "checkpoint")], [("refused", "plan_review_required"), ("approve", None), ("approve", None)])
        self.assertEqual(events(rig, sid, "launch_refused"), [])
        self.assertEqual(len(events(rig, sid, "plan_review")), 1)
        versions = events(rig, sid, "plan_version")
        self.assertEqual(len(versions), 3)
        self.assertEqual(versions[0]["to"], versions[2]["to"], "same plan version before and after the ruling")
        self.assertNotEqual(versions[0]["from"], versions[2]["from"], "the bytes hash moved with the appended ruling")
        self.golden("plan_self", {"foreman": plan_shape(rig, sid)})

    def test_review_cap_of_two_honoured_per_plan_version(self):
        rig = self.rig("ps-cap", load_fixture("plan_self"), config=CONFIG)
        pi = rig.start()
        sid = pi.session_id()
        pi.prompt("[[replay:k1]] build it", timeout=60)
        _, recs = pi.wait_child_notify(timeout=180)
        res = tool_results(recs)
        self.assertIn("refused [plan_revision_required]", res[0][2])
        _, recs = pi.wait_child_notify(timeout=180, answers=[APPROVE])
        pi.close()
        self.assertTrue(any("Plan review: FAIL after 2 of 2 rounds" in n for n in notifications(recs)), notifications(recs))
        self.assertEqual([(r["decision"], r.get("reason")) for r in events(rig, sid, "checkpoint")], [("refused", "plan_revision_required"), ("approve", None)])
        self.assertEqual([r["role"] for r in events(rig, sid, "role_launch")], ["reviewer", "reviewer"])


if __name__ == "__main__":
    unittest.main()
