"""R31c: flagged asks (`ask_flag` trace events) counted by family in the retro report (the backlog candidates and store are retired)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import _isolation  # noqa: F401  (agent dir -> temp)
import foreman_retro as fr

T0 = "2026-01-01T00:00:00Z"
LONG = "grep -c x /state/trace-01a.jsonl | cut -c1-700 | head -5 " + "&& echo padding " * 30  # well over MAX_TEXT, with a path


def flag(family="state_usage_read", cls="state_usage_read", rule="state-protect", command=LONG):
    return {"event": "ask_flag", "family": family, "class": cls, "rule": rule, "command": command, "decision": "approved"}


class FlaggedAskTest(unittest.TestCase):
    def test_P3_retro_section(self):
        self.assertEqual(fr.flagged_counts([flag(), flag(), flag("trace_read")]), {"state_usage_read": 2, "trace_read": 1})
        self.assertIsNone(fr.flagged_counts(None))
        rep = {"session": "s", "review": None, "trace": None, "usage": None, "explorer": None, "cache": None, "session_tools": None,
               "flagged_asks": {"state_usage_read": 2}}
        self.assertIn("Flagged asks: state_usage_read=2", fr.render_text(rep).replace(" ", "").replace("Flaggedasks:", "Flagged asks: "))


if __name__ == "__main__":
    unittest.main()
