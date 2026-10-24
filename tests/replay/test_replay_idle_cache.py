"""Replay: idle cache keep-alive and warm compaction (docs/cache.md) on the fake provider.

The fake provider is registered as claude-bridge (FOREMAN_FAKE_BRIDGE=1) and declares `promptCache`
(FOREMAN_FAKE_PROMPT_CACHE=1); Pi's `cacheWarming` is "idle". The cache policy has a 20 s TTL, a 30 s
interval and a 1 minute window, so Pi ticks every 10 s and the warm-compaction check lands 30 s after
the session settles. Pi's reserveTokens is 100000, so the runtime compaction point is the window minus
100000 = 100000 tokens. The last answer reports 90000 tokens: above the idle floor (50000 = half of the
point), below Pi's own threshold, so only the idle check compacts (turn_end never requests a compaction:
there is no compact_tier event and the only compaction trace is warm_idle). Expected
trace: keepalive fired (once or more), compaction warm_idle, keepalive window_end (reason compact),
and Pi really ran the compaction (a compaction entry in the session file). Same prerequisites as
test_replay.py.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import shape  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

BRIDGE = "claude-bridge"
SCRIPT = {"*": {
    "p1": [{"text": "fake: first reply " + "x" * 400}],
    "p2": [{"text": "fake: second reply " + "y" * 400, "usage": {"totalTokens": 90000}}],
}}
CONFIG = {
    "providers": {BRIDGE: {"cache": {"ttlSeconds": 20, "billing": "token",
                                     "keepalive": {"enabled": True, "intervalSeconds": 30, "windowMinutes": 1},
                                     "warmCompact": True}}},
}
SETTINGS = {"cacheWarming": "idle", "compaction": {"keepRecentTokens": 1, "reserveTokens": 100000}}
KEYS = ("event", "outcome", "reason", "point", "model")


def idle_events(recs):
    """keepalive and compaction events; consecutive `fired` collapsed, timing and token fields dropped."""
    out = []
    for r in recs:
        if r.get("event") not in ("keepalive", "compaction"):
            continue
        e = shape([r], KEYS)[0]
        if out and e == out[-1] and e.get("outcome") == "fired":
            continue
        out.append(e)
    return out


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestIdleCache(ReplayCase):
    def test_keepalive_then_one_warm_compaction(self):
        rig = self.rig("idlecache", SCRIPT, providers=(BRIDGE,), config=CONFIG, settings=SETTINGS)
        pi = rig.start(provider=BRIDGE, env={"FOREMAN_FAKE_BRIDGE": "1", "FOREMAN_FAKE_PROMPT_CACHE": "1"})
        pi.prompt("[[replay:p1]] hello", timeout=60)
        pi.prompt("[[replay:p2]] again", timeout=60)

        def ended(t):  # the first window (after p1) ends by activity when p2 arrives
            return any(r.get("event") == "keepalive" and r.get("outcome") == "window_end" and r.get("reason") != "activity" for recs in t.values() for r in recs)

        rig.wait_trace(ended, timeout=180)
        pi.drain(3)
        [recs] = [v for v in rig.traces().values() if v and v[0].get("event") == "session_start"]
        events = idle_events(recs)
        # The window opened after p1 ends by activity when p2 arrives; the golden starts at the second window's first refresh.
        events = events[next(i for i, e in enumerate(events) if e.get("outcome") == "fired"):]
        kinds = [e["event"] for e in events]
        self.assertEqual(kinds.count("compaction"), 1, events)
        self.assertNotIn("compact_tier", [r.get("event") for r in recs], "turn_end no longer requests a compaction")
        self.assertEqual([r.get("reason") for r in recs if r.get("event") == "compaction"], ["warm_idle"], "the idle warm compaction is the only compaction request")
        self.assertEqual([r.get("point") for r in recs if r.get("event") == "compaction_point"][:1], [100000], "the runtime point is traced at session start")
        self.assertEqual(events[0].get("outcome"), "fired", events)
        self.assertEqual([(e["event"], e.get("outcome"), e.get("reason")) for e in events[-2:]],
                         [("compaction", None, "warm_idle"), ("keepalive", "window_end", "compact")], events)
        self.golden("idle_cache", {"events": events})

        # Pi ran the compaction: a compaction entry in the session file.
        sessions = [f for f in rig.agent.rglob("*.jsonl") if "sessions" in f.parts]
        self.assertTrue(any('"type":"compaction"' in f.read_text("utf-8").replace(": ", ":") for f in sessions), sessions)
        pi.close()


if __name__ == "__main__":
    unittest.main()
