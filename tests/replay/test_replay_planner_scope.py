"""Planner role (plan-planner section A): a planner child writes only the plan under the scratch dir
(`write` into .workflow/scratch passes, a project file is refused and traced `planner_write_refused`),
and `planner` launches alone: inside tasks/chain it is refused (`launch_refused {reason: planner_single}`).
Same prerequisites and skips as test_replay.py."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


def events(traces, name):
    return [r for recs in traces.values() for r in recs if r.get("event") == name]


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestPlannerScope(ReplayCase):
    def test_planner_child_writes_only_the_plan(self):
        rig = self.rig("planner-scope", load_fixture("planner_scope"))
        (rig.project / "src").mkdir()
        pi = rig.start()
        pi.prompt("[[replay:p1]] go", timeout=60)
        notice, _ = pi.wait_child_notify(timeout=120)
        pi.close()
        self.assertIn("planner child finished", notice)
        self.assertEqual((rig.project / ".workflow" / "scratch" / "plan-x.md").read_text("utf-8"), "# Plan\n")
        self.assertFalse((rig.project / "src" / "a.txt").exists())
        refused = events(rig.traces(), "planner_write_refused")
        self.assertEqual([r.get("kind") for r in refused], ["write"], refused)

    def test_planner_in_tasks_or_chain_is_refused(self):
        rig = self.rig("planner-single", load_fixture("planner_scope"))
        pi = rig.start()
        res = tool_results(pi.prompt("[[replay:p2]] go", timeout=60))
        pi.close()
        self.assertEqual([(n, e) for n, e, _ in res], [("subagent", True), ("subagent", True)])
        for _, _, text in res:
            self.assertIn("planner launch refused [launch_refused:planner_single]", text)
        self.assertEqual([r.get("reason") for r in events(rig.traces(), "launch_refused")], ["planner_single"] * 2)


if __name__ == "__main__":
    unittest.main()
