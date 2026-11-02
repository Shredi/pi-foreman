"""Replay: deferred tool declarations and the harness tool_search (ledger items 2 and 4).

The real Pi starts with this package; the foreman's default `tools.deferred` hides `foreman_copy` from the declarations
(trace `tools_deferred`). The model searches for it with `tool_search`: the result prints the schema and the codemode call,
the hit is traced as `tool_found` with `unhidden: false`, and the declarations stay as they were.

Run:  python -m unittest discover -s tests/replay -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestDeferredSearch(ReplayCase):
    def test_search_prints_the_codemode_call_and_traces_the_hit(self):
        rig = self.rig("deferred_search", load_fixture("deferred_search"))
        pi = rig.start()
        recs = pi.prompt("[[replay:ds1]] go", timeout=90)
        pi.close()
        ends = [r for r in recs if r.get("type") == "tool_execution_end" and r.get("toolName") == "tool_search"]
        self.assertEqual(len(ends), 1, ends)
        text = "\n".join(c.get("text", "") for c in (ends[0].get("result") or {}).get("content") or [] if isinstance(c, dict))
        self.assertIn("tools.foreman_copy(", text)
        self.assertIn("the declarations are unchanged", text)
        events = [r for recs_ in rig.traces().values() for r in recs_]
        deferred = [r for r in events if r.get("event") == "tools_deferred"]
        self.assertEqual(len(deferred), 1, deferred)
        self.assertIn("foreman_copy", str(deferred[0].get("names")).split(","))
        found = [(r.get("name"), r.get("kind"), r.get("unhidden")) for r in events if r.get("event") == "tool_found"]
        self.assertIn(("foreman_copy", "tool", False), found)


if __name__ == "__main__":
    unittest.main()
