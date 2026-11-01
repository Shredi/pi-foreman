"""Launch refusals on the fake provider: `output`/`outputMode` launches are refused for every role
(`output_path`), and with allowWorkflow an unchecked schedule call at heavy (`unchecked_heavy`).
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
class TestLaunchRefusals(ReplayCase):
    def test_output_path_launches_are_refused(self):
        rig = self.rig("launch-output", load_fixture("launch_refusals"))
        pi = rig.start()
        res = tool_results(pi.prompt("[[replay:p3]] go", timeout=60))
        pi.close()
        self.assertEqual([(n, e) for n, e, _ in res], [("subagent", True), ("subagent", True)], res)
        for _, _, text in res:
            self.assertIn("pi-foreman: subagent launch refused [launch_refused:output_path]", text)
        self.assertEqual([r.get("reason") for r in events(rig.traces(), "launch_refused")], ["output_path"] * 2)
        self.assertEqual(events(rig.traces(), "role_launch"), [], "a refused launch records nothing")
        self.assertFalse((rig.project / "src" / "auth.ts").exists())

    def test_unchecked_schedule_is_refused_at_heavy(self):
        rig = self.rig("launch-unchecked", load_fixture("launch_refusals"), config={"safety": {"subagents": {"allowWorkflow": True}}})
        pi = rig.start()
        res = tool_results(pi.prompt("[[replay:p4]] go", timeout=60))
        pi.close()
        self.assertEqual([(n, e) for n, e, _ in res], [("foreman_triage", False), ("subagent", True)], res)
        self.assertIn("[launch_refused:unchecked_heavy]: 'schedule.list'", res[1][2])
        self.assertEqual([(r.get("reason"), r.get("tier")) for r in events(rig.traces(), "launch_refused")], [("unchecked_heavy", "heavy")])


if __name__ == "__main__":
    unittest.main()
