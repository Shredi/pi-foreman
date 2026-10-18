"""R12 item 4: a child that gets the same overlay deny twice stops its run (replay fixture child_repeat_refusal).

The builder runs `HOME=x; touch ~/rebound.txt` (binds HOME and uses it: a stop-eligible probe-class deny, launchwait.ts
REPEAT_STOP_REASONS) twice: the second identical deny reason stops the run with
`run failed: repeated guarded-token probe` and the child traces `child_repeat_refusal`; its third scripted step (`touch third.txt`)
never runs (no third attempt) and the foreman launches the builder once (no auto-retry).
Same prerequisites and skips as test_replay.py."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestChildRepeatRefusal(ReplayCase):
    def test_child_repeat_refusal(self):
        rig = self.rig("child-repeat-refusal", load_fixture("child_repeat_refusal"))
        pi = rig.start()
        pi.prompt("[[replay:b1]] go", timeout=60)
        notice, _recs = pi.wait_child_notify(timeout=120)
        pi.close()
        self.assertIsNotNone(notice)
        events = [r for recs_ in rig.traces().values() for r in recs_]
        stops = [r for r in events if r.get("event") == "child_repeat_refusal" and "kind" not in r]
        self.assertEqual([s.get("decision") for s in stops], ["stopped"], stops)
        # no third attempt: the step after the stop never ran
        self.assertFalse((rig.project / "third.txt").exists())
        self.assertFalse((rig.project / "x" / "rebound.txt").exists())
        self.assertFalse((rig.project.parent / "x").exists())
        # no auto-retry: one builder launch
        launches = [r for r in events if r.get("event") == "role_launch"]
        self.assertEqual(len(launches), 1, launches)
        text = "\n".join(p.read_text("utf-8", "replace") for p in rig.agent.rglob("*.jsonl"))
        self.assertIn("run failed: repeated guarded-token probe", text)
        # the parent saw the marker end to end: its stop record (kind repeat_refusal), the run failed
        parent = [r for r in events if r.get("event") == "child_repeat_refusal" and r.get("kind") == "repeat_refusal"]
        self.assertEqual([(p.get("decision"), p.get("outcome"), p.get("exit")) for p in parent], [("stopped", "failed", 1)], parent)


if __name__ == "__main__":
    unittest.main()
