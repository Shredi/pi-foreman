"""Replay: a child builder's heredoc write into its own scratch dir is allowed (ceremony-fixes-2 item 4).

`cat > $FOREMAN_SCRATCH/probe.py <<'EOF'` followed by `python3 -I $FOREMAN_SCRATCH/probe.py` runs without a dialog: the file is
listed, the run output appears in the builder's session and the heredoc deny reason does not (the gate may still ask the parent
about the unresolved `$FOREMAN_SCRATCH` redirect; the test allows it once). The workspace-target counterpart is
test_replay_child_heredoc.py.
Same prerequisites and skips as test_replay.py."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

DENIED = "never heredoc or stdin-script file writes"


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestChildScratchHeredoc(ReplayCase):
    def test_child_builder_scratch_heredoc_runs(self):
        rig = self.rig("scratchheredoc", load_fixture("child_scratch_heredoc"), permissions="baseline", config={"review": {"headless": True}})
        pi = rig.start()
        res = tool_results(pi.prompt("[[replay:s1]] go", timeout=60))
        self.assertEqual([(n, e) for n, e, _ in res], [("subagent", False)])
        # the shell parser leaves a `$FOREMAN_SCRATCH` redirect target unresolved, so the gate may still ask the parent (danger-opaque);
        # the child rule no longer denies, and an allow-once runs the line
        notice, recs = pi.wait_child_notify(timeout=120, answers=[{"value": "allow once"}] * 6)
        pi.close()
        self.assertIn("child: scratch heredoc finished", notice)
        text = "\n".join(p.read_text("utf-8", "replace") for p in rig.agent.rglob("*.jsonl"))
        self.assertIn("probe.py", text)  # the ls output: the file exists
        self.assertIn("scratch-heredoc-ran", text)  # the run output
        self.assertNotIn(DENIED, text)


if __name__ == "__main__":
    unittest.main()
