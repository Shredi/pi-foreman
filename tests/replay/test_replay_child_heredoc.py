"""Replay: a child builder's heredoc file write is denied without a dialog (R5 P2 S2, ledger 11 R2).

`cat > heredoc.txt <<'EOF'` in a builder's bash is refused with the reason `never heredoc or stdin-script
file writes`; the file never appears and the foreman is not asked.
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
class TestChildHeredoc(ReplayCase):
    def test_child_builder_heredoc_write_denied(self):
        rig = self.rig("shellwritechildheredoc", load_fixture("shell_write"))
        pi = rig.start()
        res = tool_results(pi.prompt("[[replay:childheredoc]] start", timeout=60))
        self.assertEqual([(n, e) for n, e, _ in res], [("subagent", False)])
        notice, recs = pi.wait_child_notify(timeout=120)
        pi.close()
        self.assertIn("child: heredoc finished", notice)
        dialogs = [r for r in recs if r.get("type") == "extension_ui_request" and r.get("method") in ("select", "confirm")]
        self.assertEqual(dialogs, [], dialogs)
        self.assertFalse([p for p in rig.root.rglob("heredoc.txt") if p.is_file()], "the builder's heredoc write ran")
        text = "\n".join(p.read_text("utf-8", "replace") for p in rig.agent.rglob("*.jsonl"))
        self.assertIn(DENIED, text)


if __name__ == "__main__":
    unittest.main()
