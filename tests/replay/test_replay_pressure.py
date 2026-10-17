"""Replay: host pressure gate on child launches (R5 P1b) on the fake provider.

The sampler never reads the live host: the rig sets PI_FOREMAN_PRESSURE_FIXTURE, so scripts/foreman_pressure.py
classifies a fixture host sample (host.json, rewritten by the test) against the default limits every 5 s
(resources.sampleSeconds) and writes pressure.json.

high: three launches in one message -> the first runs, two are queued (`launch_narrowed`); once no run is
active a `pressure` wait wakes the foreman with the queued launches' arguments.
critical: the launch is refused with the deferral text (`launch_deferred`, no `launch_refused`); when the level
drops a `pressure` wait wakes the foreman with the original arguments, which it relaunches.
ok: all three launches run and no pressure event is traced.
Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import json
import os
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, shape, tool_results, wake_messages  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

CONFIG = {"resources": {"sampleSeconds": 5}}
# default limits: maxLoadPerCore 1.5 (high above it, critical from twice it)
HOSTS = {
    "ok": {"loadPerCore": 0.1, "freeMemMB": 16000, "freeDiskGB": 500},
    "high": {"loadPerCore": 2.0, "freeMemMB": 16000, "freeDiskGB": 500},
    "critical": {"loadPerCore": 4.0, "freeMemMB": 16000, "freeDiskGB": 500},
}
PRESSURE_EVENTS = ("launch_narrowed", "launch_deferred", "climb_suppressed", "launch_refused", "wait")
KEYS = ("event", "width", "reasons", "level", "decision", "toolFamily", "wakeKinds")
DEFERRED = "pressure critical (load): launch deferred; you will be woken when it drops"


def set_host(rig, level):
    host = rig.root / "host.json"
    tmp = rig.root / "host.json.tmp"
    tmp.write_text(json.dumps(HOSTS[level]), "utf-8")
    os.replace(str(tmp), str(host))
    return host


def wait_level(rig, level, timeout=40.0):
    """Block until the sampler wrote pressure.json at `level`."""
    path = rig.state_dir / "pressure.json"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if json.loads(path.read_text("utf-8")).get("level") == level:
                return
        except (OSError, ValueError):
            pass
        time.sleep(0.25)
    raise AssertionError("pressure.json never reached level %s" % level)


def wake_and_settle(pi, timeout):
    """Records until a foreman_wake message arrived and the run it started settled; returns (normalised wake text, records)."""
    deadline = time.time() + timeout
    out, wake = [], None
    while True:
        rec = pi._next(deadline)
        out.append(rec)
        for kind, text in wake_messages([rec]):
            if kind == "foreman_wake" and "pressure" in text:
                wake = text
        if wake is not None and rec.get("type") == "agent_settled":
            return wake, out


def pressure_trace(rig, sid):
    safe = "".join(c for c in sid if c.isalnum() or c in "-_")
    return [r for r in rig.traces().get("trace-" + safe, []) if r.get("event") in PRESSURE_EVENTS]


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestPressure(ReplayCase):
    def start(self, name, level):
        rig = self.rig(name, load_fixture("pressure"), config=CONFIG)
        host = set_host(rig, level)
        pi = rig.start(env={"PI_FOREMAN_PRESSURE_FIXTURE": str(host)})
        wait_level(rig, level)
        return rig, pi, pi.session_id()

    def test_high_narrows_to_one_launch_and_queues_the_rest(self):
        rig, pi, sid = self.start("pressure-high", "high")
        # tool results arrive in completion order: the queued (refused) calls end before the launch that runs
        res = sorted(tool_results(pi.prompt("[[replay:hi]] map it", timeout=120)), key=lambda r: r[1])
        self.assertEqual([(n, e) for n, e, _ in res], [("subagent", False), ("subagent", True), ("subagent", True)], res)
        for _, _, text in res[1:]:
            self.assertIn("pressure high (load): child launches run one at a time; this launch is queued", text)
        wake, _ = wake_and_settle(pi, 90)
        pi.close()
        content = wake
        self.assertIn("(pressure)", content)
        self.assertIn("pressure: high, a run ended; relaunch the queued launches one at a time with: ", content)
        self.assertIn("[[replay:qa]] map part b", content)
        self.assertIn("[[replay:qb]] map part c", content)
        self.assertNotIn("[[replay:x-done]]", content, "the launch that ran is not queued")
        events = pressure_trace(rig, sid)
        self.assertEqual([(r["width"], r["reasons"]) for r in events if r["event"] == "launch_narrowed"], [(1, "load")])
        self.assertEqual([r for r in events if r["event"] == "launch_refused"], [])
        self.golden_pressure("high", events)

    def test_critical_defers_and_a_wake_carries_the_original_arguments(self):
        rig, pi, sid = self.start("pressure-critical", "critical")
        res = tool_results(pi.prompt("[[replay:crit]] map it", timeout=120))
        self.assertEqual([(n, e, t) for n, e, t in res], [("subagent", True, DEFERRED)])
        set_host(rig, "ok")
        wake, recs = wake_and_settle(pi, 90)
        pi.close()
        original = {"agent": "explorer", "task": "[[replay:cr]] map the repo"}
        self.assertIn("pressure: ok, relaunch with: " + json.dumps(original, separators=(",", ":")), wake)
        # the foreman relaunched with those arguments; nothing launched by itself before
        relaunch = tool_results(recs)
        self.assertEqual([(n, e) for n, e, _ in relaunch], [("subagent", False)], relaunch)
        events = pressure_trace(rig, sid)
        self.assertEqual([(r["level"], r["reasons"]) for r in events if r["event"] == "launch_deferred"], [("critical", "load")])
        self.assertEqual([r for r in events if r["event"] == "launch_refused"], [])
        self.golden_pressure("critical", events)

    def test_ok_runs_all_three_launches_and_traces_no_pressure_event(self):
        rig, pi, sid = self.start("pressure-ok", "ok")
        res = tool_results(pi.prompt("[[replay:ok3]] map it", timeout=120))
        pi.close()
        self.assertEqual([(n, e) for n, e, _ in res], [("subagent", False)] * 3, res)
        events = pressure_trace(rig, sid)
        self.assertEqual(events, [])
        self.golden_pressure("ok", events)

    def golden_pressure(self, name, events):
        path = Path(__file__).resolve().parent / "golden" / "pressure.json"
        have = json.loads(path.read_text("utf-8")) if path.exists() else {}
        actual = shape(events, KEYS)
        if os.environ.get("FOREMAN_REPLAY_UPDATE_GOLDEN") == "1":
            have[name] = actual
            path.write_text(json.dumps(dict(sorted(have.items())), indent=1) + "\n", "utf-8")
        self.assertEqual(actual, have.get(name))


if __name__ == "__main__":
    unittest.main()
