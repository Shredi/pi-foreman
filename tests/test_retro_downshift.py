"""foreman_retro cache line: downshifted turns (foreman_model trace events with reason idle_cold)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_retro as fr  # noqa: E402


def event(reason):
    return {"event": "foreman_model", "reason": reason, "from": "p/a", "to": "p/b"}


class DownshiftLineTest(unittest.TestCase):
    def metrics(self, trace):
        return fr.cache_metrics(trace, [], "s1", {})

    def test_counts_idle_cold_only(self):
        c = self.metrics([event("idle_cold"), event("owner"), event("idle_cold"), event("answer")])
        self.assertEqual(c["downshiftedTurns"], 2)
        self.assertTrue(fr.cache_line(c).endswith(", cold resumes 0, downshifted turns 2"))

    def test_no_downshift_keeps_old_line(self):
        c = self.metrics([event("owner"), {"event": "compaction", "reason": "warm_idle"}])
        self.assertNotIn("downshiftedTurns", c)
        self.assertNotIn("downshifted", fr.cache_line(c))


if __name__ == "__main__":
    unittest.main()
