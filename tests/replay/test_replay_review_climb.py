"""Replay: reviewer on-find climb, review panel and plan review (review-climb item 15) on the fake provider.

On-find: `ladder.reviewerClimb` mode on-find with rungs [reviewer, senior-reviewer]; the rung-0 reviewer
FAILs item 1 with a located `calc.py:2` finding, so the next reviewer launch runs on rung 1, whose clean
PASS ends the climb (`rung_up` on_find, `finding`, `climb_done` clean after 2 rungs).
Panel: `ladder.reviewPanel` with a senior-reviewer shadow on `pre-pr`. The pinned pi-subagents 0.75.0 runs no
panel launch shape, so the panel degrades: `panel {decision: unsupported}`, the launch stays one primary
reviewer whose PASS marks the item and lets `gh pr create` through; no shadow child runs.
Plan review: at heavy with `ceremony.planReview.heavy` on, the checkpoint is refused
(`plan_review_required`) until a `[plan-review]` reviewer (a model other than the foreman's) gave a
verdict; then the dialog opens with the verdict line.
Goldens keep the review events only. Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

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
REVIEW_EVENTS = ("role_launch", "rung_up", "finding", "climb_done", "panel", "plan_review", "review_model", "checkpoint")


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
    def test_on_find_climb(self):
        cfg = {"ladder": {"reviewerClimb": {"enabled": True, "mode": "on-find", "rungs": [CHEAP, STRONG]}}}
        rig = self.rig("rc-onfind", load_fixture("review_climb"), config=cfg)
        changed_calc(rig)
        pi = rig.start()
        sid = pi.session_id()
        pi.prompt("[[replay:c1]] fix add", timeout=60)
        for _ in range(2):
            pi.wait_child_notify(timeout=180)
        pi.close()
        [f] = events(rig, sid, "finding")
        self.assertEqual((f["file"], f["line"], f["class"], f["model"], f["gate"], f["primary"]), ("calc.py", 2, "off-by-one", CHEAP, "item", True), f)
        ups = events(rig, sid, "rung_up")
        self.assertIn({"event": "rung_up", "role": "reviewer", "from": CHEAP, "to": STRONG, "reason": "on_find", "item": "1"},
                      [{k: v for k, v in r.items() if k != "ts"} for r in ups], ups)
        self.assertTrue(all(r["reason"] == "on_find" for r in ups), ups)
        self.assertEqual([(r["reason"], r["rungs"], r["item"]) for r in events(rig, sid, "climb_done")], [("clean", 2, "1")])
        self.golden("review_climb_on_find", {"foreman": review_shape(rig, sid)})

    def test_panel_degrades_and_never_blocks(self):
        cfg = {"ladder": {"reviewPanel": {"shadows": [STRONG], "gates": ["pre-pr"]}}}
        rig = self.rig("rc-panel", load_fixture("review_climb"), config=cfg)
        changed_calc(rig)
        bindir, marker = fake_gh(rig)
        pi = rig.start(env={"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", "")})
        sid = pi.session_id()
        pi.prompt("[[replay:p1]] fix add", timeout=60)
        pi.wait_child_notify(timeout=180)
        [pr] = tool_results(pi.prompt("[[replay:pr-gh]] open the PR", timeout=60))
        pi.close()
        self.assertEqual([(r["gate"], r["models"], r["primary"], r["decision"]) for r in events(rig, sid, "panel")], [("pre-pr", STRONG, CHEAP, "unsupported")])
        self.assertEqual([r["role"] for r in events(rig, sid, "role_launch")], ["reviewer"])
        self.assertIsNone(trace_of(rig.traces(), "child", STRONG), "no shadow child ran")
        self.assertEqual([r for r in events(rig, sid, "finding") if not r["primary"]], [])
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
