"""Replay: idle cache keep-alive and warm compaction (docs/cache.md) on the fake provider.

The fake provider is registered as claude-bridge (FOREMAN_FAKE_BRIDGE=1) and declares `promptCache`
(FOREMAN_FAKE_PROMPT_CACHE=1). pi-foreman's replay sender owns the warming (Pi's own warmer is
never consulted). The cache policy has a 20 s TTL, so a warm is due 10 s after the last request. Pi's
reserveTokens is 40000, so Pi's own compaction point is 200000 - 40000 = 160000 tokens. The last answer
reports 130000 tokens: above the final-warm gate (0.6 x the 200000 window = 120000), below Pi's own
threshold, so only the final warm compaction runs (turn_end never requests one: there is no compact_tier
event and the only compaction trace is final_warm). Priced fake models make the budget hold one warm.
Expected trace: keepalive fired, keepalive skipped (post_warm: no budget for another), compaction
final_warm, keepalive window_end (reason budget), and Pi really ran the compaction (a compaction entry in
the session file). Same prerequisites as test_replay.py.
"""
from __future__ import annotations

import json
import os
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import shape  # noqa: E402
from test_replay import GOLDEN, REASON, ReplayCase  # noqa: E402

BRIDGE = "claude-bridge"
SCRIPT = {"*": {
    "p1": [{"text": "fake: first reply " + "x" * 400}],
    "p2": [{"text": "fake: second reply " + "y" * 400, "usage": {"totalTokens": 130000}}],
}}
CONFIG = {
    "providers": {BRIDGE: {"cache": {"ttlSeconds": 20, "billing": "token",
                                     "keepalive": {"enabled": True, "compactMinTokens": 0},  # the fake contexts are tiny
                                     "warmCompact": True}}},
}
SETTINGS = {"compaction": {"keepRecentTokens": 1, "reserveTokens": 40000}}
KEYS = ("event", "outcome", "reason", "point", "model", "tier", "phase", "trigger")
NEW_KEYS = ("event", "outcome", "reason", "trigger", "from", "to", "cause")
ENV = {"FOREMAN_FAKE_BRIDGE": "1", "FOREMAN_FAKE_PROMPT_CACHE": "1"}


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


def kept(recs, names, keys=NEW_KEYS):
    """Shaped events of the given names, in order."""
    return [shape([r], keys)[0] for r in recs if r.get("event") in names]


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestIdleCache(ReplayCase):
    def golden_key(self, key, actual):
        """Compare one scenario of golden/idle_cache.json (the file holds one key per scenario)."""
        path = GOLDEN / "idle_cache.json"
        data = json.loads(path.read_text("utf-8"))
        if os.environ.get("FOREMAN_REPLAY_UPDATE_GOLDEN") == "1":
            data[key] = actual
            path.write_text(json.dumps(data, indent=1) + "\n", "utf-8")
        self.assertEqual(actual, data[key])

    def session_trace(self, rig):
        [recs] = [v for v in rig.traces().values() if v and v[0].get("event") == "session_start"]
        return recs

    def test_keepalive_then_one_warm_compaction(self):
        rig = self.rig("idlecache", SCRIPT, providers=(BRIDGE,), config=CONFIG, settings=SETTINGS)
        pi = rig.start(provider=BRIDGE, env=dict(ENV, FOREMAN_FAKE_COST="1,1,3,20"))
        # cold = 16 tokens x 20 = 320e-6, quarter budget 80e-6; one warm costs 16 x 3 + 1 = 49e-6, a second would not fit.
        pi.prompt("[[replay:p1]] hello", timeout=60)
        pi.prompt("[[replay:p2]] again", timeout=60)

        def ended(t):  # the stretch after p1 is replaced by p2's request; the one after p2 ends with the final compaction
            return any(r.get("event") == "keepalive" and r.get("outcome") == "window_end" for recs in t.values() for r in recs)

        rig.wait_trace(ended, timeout=180)
        pi.drain(3)
        [recs] = [v for v in rig.traces().values() if v and v[0].get("event") == "session_start"]
        events = idle_events(recs)
        kinds = [e["event"] for e in events]
        self.assertEqual(kinds.count("compaction"), 1, events)
        self.assertNotIn("compact_tier", [r.get("event") for r in recs], "turn_end no longer requests a compaction")
        self.assertEqual([r.get("trigger") for r in recs if r.get("event") == "compaction"], ["final_warm"], "the final warm compaction is the only compaction request")
        self.assertEqual([r.get("point") for r in recs if r.get("event") == "compaction_point"][:1], [160000], "the runtime point is traced at session start")
        self.assertEqual(events[0].get("outcome"), "fired", events)
        self.assertEqual([(e["event"], e.get("outcome"), e.get("reason")) for e in events[-3:]],
                         [("keepalive", "skipped", "budget"), ("compaction", None, "warm_idle"), ("keepalive", "window_end", "budget")], events)
        self.golden_key("events", events)

        # Pi ran the compaction: a compaction entry in the session file.
        sessions = [f for f in rig.agent.rglob("*.jsonl") if "sessions" in f.parts]
        self.assertTrue(any('"type":"compaction"' in f.read_text("utf-8").replace(": ", ":") for f in sessions), sessions)
        pi.close()

    def test_budget_exhaustion_compacts_at_settle_with_trigger_final_warm(self):
        """Priced fake models: the first warm already costs more than the quarter budget, so none is sent (budget)
        and the final warm compaction runs at the settle grace (trigger final_warm)."""
        cfg = json.loads(json.dumps(CONFIG))
        cfg["providers"][BRIDGE]["cache"]["keepalive"]["budgetShare"] = 0.5
        rig = self.rig("idlebudget", SCRIPT, providers=(BRIDGE,), config=cfg, settings=SETTINGS)
        # cold = 16 tokens x 10 = 160e-6, quarter budget 40e-6; the first warm is estimated at 16 x 5 + 1 output (15) = 95e-6: refused.
        pi = rig.start(provider=BRIDGE, env=dict(ENV, FOREMAN_FAKE_COST="3,15,5,10"))
        pi.prompt("[[replay:p1]] hello", timeout=60)
        pi.prompt("[[replay:p2]] again", timeout=60)
        rig.wait_trace(lambda t: any(r.get("event") == "compaction" for recs in t.values() for r in recs), timeout=180)
        pi.drain(3)
        events = kept(self.session_trace(rig), ("keepalive", "compaction", "budget"))
        events = [e for e in events if not (e["event"] == "keepalive" and e.get("reason") == "activity")]
        self.assertIn({"event": "compaction", "reason": "warm_idle", "trigger": "final_warm"}, events)
        self.assertNotIn("fired", [e.get("outcome") for e in events], events)
        self.golden_key("budget", events)
        pi.close()

    def test_away_owner_warms_under_the_quarter_tier(self):
        """A fake probe reports an hour of idle input (awayAfterMinutes 1, past the 15 min grace): the owner is away,
        the warm still goes out under the quarter tier, then the final warm compaction runs."""
        cfg = json.loads(json.dumps(CONFIG))
        cfg["presence"] = {"enabled": True, "awayAfterMinutes": 1, "command": "echo 3600"}
        rig = self.rig("idleaway", SCRIPT, providers=(BRIDGE,), config=cfg, settings=SETTINGS)
        pi = rig.start(provider=BRIDGE, env=dict(ENV, FOREMAN_FAKE_COST="1,1,3,20"))
        pi.prompt("[[replay:p1]] hello", timeout=60)
        pi.prompt("[[replay:p2]] again", timeout=60)
        rig.wait_trace(lambda t: any(r.get("event") == "compaction" for recs in t.values() for r in recs), timeout=180)
        pi.drain(3)
        events = kept(self.session_trace(rig), ("keepalive", "compaction", "presence"), NEW_KEYS + ("tier", "presence"))
        self.assertIn({"event": "keepalive", "outcome": "fired", "reason": "idle", "tier": "quarter", "presence": "away"}, events)
        self.assertIn({"event": "compaction", "reason": "warm_idle", "trigger": "final_warm"}, events)
        self.golden_key("away", events)
        pi.close()

    def test_cold_downshift_on_child_notice_and_restore_on_prompt(self):
        """Cache gone cold (keep-alive off, TTL 20 s): a triggerTurn notice runs on the idle rung, the next
        owner prompt restores the base model."""
        cfg = json.loads(json.dumps(CONFIG))
        cfg["providers"][BRIDGE]["cache"]["keepalive"] = {"enabled": False}
        cfg["providers"][BRIDGE]["roles"] = {"foreman": {"idle": {"model": BRIDGE + "/planner"}}}
        script = {"*": dict(SCRIPT["*"], t1=[{"text": "fake: notice handled"}], p3=[{"text": "fake: owner back"}])}
        rig = self.rig("idledownshift", script, providers=(BRIDGE,), config=cfg, settings=SETTINGS)
        pi = rig.start(provider=BRIDGE, env=ENV)
        pi.prompt("[[replay:p1]] hello", timeout=60)
        time.sleep(24)  # past the 20 s TTL: the next turn starts cold
        pi.send({"id": pi.next_id(), "type": "prompt", "message": "/replay-trigger t1 subagent-notify"})
        pi.drain(5)
        pi.prompt("[[replay:p3]] back", timeout=60)
        pi.drain(2)
        events = kept(self.session_trace(rig), ("foreman_model",))
        self.assertEqual([(e.get("reason"), e.get("cause")) for e in events], [("idle_cold", "child"), ("owner", None)], events)
        self.golden_key("downshift", events)
        pi.close()


if __name__ == "__main__":
    unittest.main()
