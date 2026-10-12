"""Replay: reviewer repeat-fail climb, review panel and plan review on the fake provider.

Repeat-fail: `ladder.reviewerClimb` enabled with reviewer.strong = senior-reviewer; the reviewer FAILs
item 1 twice with a located `calc.py:2` finding, so the third reviewer launch goes to the strong rung
(`rung_up` review_fail_repeat), whose PASS ends the round.
Panel: `ladder.reviewPanel` with a senior-reviewer shadow on `pre-pr`. The primary reviewer runs alone; its run end
lists the shadow launch, the foreman issues `[panel-shadow:<strong>] [pre-pr]` (`panel {decision: launched}`), the
shadow child runs on the strong model and its FAIL finding is recorded as `primary: false`. Only the primary PASS
marks the item and lets `gh pr create` through; the composed panel block arrives once the shadow ended.
Plan review: at heavy with `ceremony.planReview.heavy` on, the checkpoint is refused
(`plan_review_required`) until a `[plan-review]` reviewer (a model other than the foreman's) gave a
verdict; then the dialog opens with the verdict line.
Goldens keep the review events only. Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import PROVIDER_A, load_fixture, trace_of, notifications, shape, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402
from test_replay_ceremony_gate import events  # noqa: E402
from test_replay_diff_facts import git  # noqa: E402
from test_replay_pr_gate import fake_gh  # noqa: E402

CHEAP, STRONG = PROVIDER_A + "/reviewer", PROVIDER_A + "/senior-reviewer"
FOREMAN = PROVIDER_A + "/foreman"
CALC = "def add(a, b):\n    return a + b\n"
REVIEW_EVENTS = ("role_launch", "rung_up", "finding", "panel", "plan_review", "review_model", "checkpoint")


def review_shape(rig, sid):
    safe = "".join(c for c in sid if c.isalnum() or c in "-_")
    return shape([r for r in rig.traces()["trace-" + safe] if r.get("event") in REVIEW_EVENTS])


def changed_calc(rig):
    """calc.py committed, then changed in the working tree: the review diff names it."""
    (rig.project / "calc.py").write_text(CALC, "utf-8")
    git(rig.project, "add", "calc.py")
    git(rig.project, "commit", "-q", "-m", "init")
    (rig.project / "calc.py").write_text(CALC.replace("a + b", "a - b"), "utf-8")


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestReviewClimb(ReplayCase):
    def test_repeat_fail_climb(self):
        cfg = {"ladder": {"reviewerClimb": {"enabled": True}},
               "providers": {PROVIDER_A: {"roles": {"reviewer": {"strong": {"model": STRONG}}}}}}
        rig = self.rig("rc-repeat", load_fixture("review_climb"), config=cfg)
        changed_calc(rig)
        pi = rig.start()
        sid = pi.session_id()
        pi.prompt("[[replay:c1]] fix add", timeout=60)
        for _ in range(3):
            pi.wait_child_notify(timeout=180)
        pi.close()
        self.assertEqual([(f["file"], f["line"], f["model"], f["gate"]) for f in events(rig, sid, "finding")],
                         [("calc.py", 2, CHEAP, "item")] * 2)
        ups = [{k: v for k, v in r.items() if k != "ts"} for r in events(rig, sid, "rung_up")]
        self.assertEqual(ups, [{"event": "rung_up", "role": "reviewer", "from": CHEAP, "to": STRONG, "reason": "review_fail_repeat", "item": "1"}])
        self.assertIsNotNone(trace_of(rig.traces(), "child", STRONG), "the third review ran on the strong rung")
        self.golden("review_climb_repeat_fail", {"foreman": review_shape(rig, sid)})

    def test_panel_shadow_launch_never_blocks(self):
        cfg = {"ladder": {"reviewPanel": {"shadows": [STRONG], "gates": ["pre-pr"]}}}
        rig = self.rig("rc-panel", load_fixture("review_climb"), config=cfg)
        changed_calc(rig)
        bindir, marker = fake_gh(rig)
        pi = rig.start(env={"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", "")})
        sid = pi.session_id()
        recs = pi.prompt("[[replay:p1]] fix add", timeout=60)
        for _ in range(2):
            recs += pi.wait_child_notify(timeout=180)[1]
        recs += pi.drain(3)
        [pr] = tool_results(pi.prompt("[[replay:pr-gh]] open the PR", timeout=60))
        pi.close()
        self.assertEqual([(r["gate"], r["models"], r["primary"], r["decision"]) for r in events(rig, sid, "panel")], [("pre-pr", STRONG, CHEAP, "launched")])
        self.assertEqual([r["role"] for r in events(rig, sid, "role_launch")], ["reviewer", "reviewer"])
        self.assertIsNotNone(trace_of(rig.traces(), "child", STRONG), "the shadow child ran on the strong model")
        self.assertEqual([(r["model"], r["file"]) for r in events(rig, sid, "finding") if not r["primary"]], [(STRONG, "calc.py")])
        self.assertEqual([r["decision"] for r in events(rig, sid, "review_done") if r.get("kind") != "shadow"], ["pass"], "the shadow's FAIL notice counts for nothing (its review_done carries kind shadow)")
        dumps = [json.dumps(r) for r in recs]
        self.assertTrue(any("[panel-shadow:%s] [pre-pr]" % STRONG in d and "issue these shadow reviews" in d for d in dumps), "the shadow instruction reached the foreman")
        self.assertTrue(any("pi-foreman-panel" in d and "Shadow findings (do not block)" in d for d in dumps), "the composed panel block was delivered")
        ledger = (rig.project / ".workflow" / "LEDGER-rp.md").read_text("utf-8")
        self.assertIn("- [x] 1. fix add — verified by reviewer PASS", ledger)
        self.assertFalse(pr[1], pr)
        self.assertTrue(marker.exists(), "the primary PASS did not open the PR gate")
        self.assertEqual(events(rig, sid, "pr_refused"), [])
        self.golden("review_panel", {"foreman": review_shape(rig, sid)})

    def test_plan_review_before_checkpoint(self):
        rig = self.rig("rc-plan", load_fixture("review_climb"), config={"ceremony": {"planReview": {"heavy": True}}})
        pi = rig.start()
        sid = pi.session_id()
        res = tool_results(pi.prompt("[[replay:q1]] build it", timeout=60))
        self.assertEqual([(n, e) for n, e, _ in res][-2:], [("foreman_checkpoint", True), ("subagent", False)], res)
        self.assertIn("refused [plan_review_required]", res[-2][2])
        _, recs = pi.wait_child_notify(timeout=180, answers=[{"value": "approve"}])
        pi.close()
        [cp] = tool_results(recs, "foreman_checkpoint")
        self.assertIn("The owner approved plan-pq.md", cp[2])
        self.assertTrue(any("Plan review: PASS (reviewer %s)" % CHEAP in n for n in notifications(recs)), notifications(recs))
        self.assertEqual([(r["decision"], r.get("reason")) for r in events(rig, sid, "checkpoint")], [("refused", "plan_review_required"), ("approve", None)])
        [pr] = events(rig, sid, "plan_review")
        self.assertEqual((pr["model"], pr["decision"]), (CHEAP, "pass"))
        self.assertNotEqual(pr["model"], FOREMAN, "the plan reviewer runs on a model other than the foreman's")
        self.assertEqual(events(rig, sid, "review_model"), [], "models differ, so the rule did not move the reviewer")
        self.golden("plan_review", {"foreman": review_shape(rig, sid)})


if __name__ == "__main__":
    unittest.main()
