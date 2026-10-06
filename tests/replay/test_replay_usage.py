"""Replay: usage log (D8) and turn causes (D9).

A user prompt makes the foreman launch one detached builder; the builder's completion notice
starts a second foreman run. The usage file in the rig's agent dir (never the real ~/.pi) gets
foreman lines and a builder line carrying the launch id the foreman bound to the launch, kind
`first` and the four token kinds; the foreman trace gets a `turn` event per run with cause
`user`, then `child`. Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

TOKENS = {"input": 10, "cacheRead": 4, "cacheWrite": 2, "output": 5}


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestUsage(ReplayCase):
    def test_usage_lines_and_turn_causes(self):
        rig = self.rig("usage", load_fixture("usage"))
        pi = rig.start()
        sid = pi.session_id()
        res = tool_results(pi.prompt("[[replay:u1]] start", timeout=60))
        self.assertEqual([(n, e) for n, e, _ in res], [("subagent", False)])
        notice, _ = pi.wait_child_notify(timeout=120)
        self.assertIn("child: job done", notice)
        pi.close()

        safe = "".join(c for c in sid if c.isalnum() or c in "-_")
        lines = [json.loads(x) for x in (rig.state_dir / "usage" / (safe + ".jsonl")).read_text("utf-8").splitlines() if x.strip()]
        foreman = [x for x in lines if x["role"] == "foreman"]
        child = [x for x in lines if x["role"] == "builder"]
        self.assertEqual(len(foreman), 3, lines)
        self.assertEqual(len(child), 1, lines)
        for x in lines:
            self.assertEqual(x["foremanSession"], sid)
            self.assertEqual({k: x[k] for k in TOKENS}, TOKENS)
            self.assertEqual(sorted(x["cost"]), ["cacheRead", "cacheWrite", "input", "output", "total"])
            self.assertTrue(x["workspace"])
        self.assertEqual({(x["kind"], x["launchId"]) for x in foreman}, {("foreman", None)})
        c = child[0]
        self.assertEqual((c["kind"], c["provider"], c["model"], c["stopReason"]), ("first", "foreman-fake", "builder", "stop"))
        self.assertTrue(c["launchId"])
        self.assertEqual(c["workspace"], foreman[0]["workspace"])

        turns = [r for r in rig.traces()["trace-" + safe] if r.get("event") == "turn"]
        self.assertEqual([(t["cause"], t["cacheWrite"], t["cacheRead"]) for t in turns], [("user", 4, 8), ("child", 2, 4)])
        llm = [r for r in rig.traces()["trace-" + safe] if r.get("event") == "llm"]
        self.assertEqual({(r["cacheRead"], r["cacheWrite"]) for r in llm}, {(4, 2)})


if __name__ == "__main__":
    unittest.main()
