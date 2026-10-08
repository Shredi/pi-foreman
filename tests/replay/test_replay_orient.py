"""Replay: default read budget before the first launch (4/8) and the orientation packet
(ceremony.orientation) on the fake provider.

Nine reads before any launch: the ninth is denied with the explorer + `/foreman budget lift` text,
a started explorer lifts it. The orientation packet is in the foreman's system prompt, byte-identical
on every request, with an `orientation` trace event (lines > 0); `enabled: false` sends no packet and
traces `lines: 0`.
Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results, trace_of  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


def events(rig, name):
    return [r for r in trace_of(rig.traces(), "foreman") if r.get("event") == name]


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestDefaultReadBudget(ReplayCase):
    def test_ninth_read_denied_then_explorer_lifts(self):
        rig = self.rig("or-budget", load_fixture("orient"), config={"ceremony": {"orientation": {"enabled": False}}})
        (rig.project / "a.txt").write_text("alpha\n", "utf-8")
        pi = rig.start()
        res = tool_results(pi.prompt("[[replay:nine]] go", timeout=120))
        pi.close()
        self.assertEqual([(n, e) for n, e, _ in res], [("read", False)] * 8 + [("read", True), ("subagent", False), ("read", False)], res)
        self.assertIn("[read_budget_exceeded] 8 read calls before the first launch (limit 8)", res[8][2])
        self.assertIn("Launch the explorer", res[8][2])
        self.assertIn("/foreman budget lift", res[8][2])


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestOrientation(ReplayCase):
    def run_two(self, name, cfg):
        rig = self.rig(name, load_fixture("orient"), config=cfg)
        (rig.project / "a.txt").write_text("alpha\n", "utf-8")
        (rig.project / "src").mkdir()
        (rig.project / "src" / "m.py").write_text("x = 1\n", "utf-8")
        (rig.project / "AGENTS.md").write_text("# Rules\nbe brief\n", "utf-8")
        subprocess.run(["git", "add", "."], cwd=str(rig.project), check=True, stdout=subprocess.DEVNULL)
        log = rig.root / "requests.jsonl"
        pi = rig.start(env={"FOREMAN_FAKE_REQUESTS": str(log)})
        pi.prompt("[[replay:ori]] first", timeout=60)
        pi.prompt("[[replay:ori]] second", timeout=60)
        pi.close()
        return rig, [json.loads(line) for line in log.read_text("utf-8").splitlines() if line.strip()]

    @staticmethod
    def system_text(req):
        return "\n".join(str((m.get("sections") or {}).get("pi-foreman") or "") for m in req if m.get("role") == "system")

    def test_packet_in_system_prompt_stable_and_traced(self):
        rig, reqs = self.run_two("or-on", {})
        self.assertEqual(len(reqs), 2)
        for req in reqs:
            sys_text = self.system_text(req)
            self.assertIn("# Orientation", sys_text)
            self.assertIn("src/ (1)", sys_text)
            self.assertIn("be brief", sys_text)
            self.assertIn("read budget before the first launch is 4/8", sys_text)
            self.assertNotIn(str(rig.project), sys_text, "relative paths only")
        self.assertEqual(self.system_text(reqs[0]), self.system_text(reqs[1]), "packet bytes do not change between turns")
        [ev] = events(rig, "orientation")
        self.assertGreater(ev["lines"], 0)

    def test_disabled_sends_nothing_and_traces_zero(self):
        rig, reqs = self.run_two("or-off", {"ceremony": {"orientation": {"enabled": False}}})
        self.assertEqual(len(reqs), 2)
        self.assertNotIn("# Orientation", "".join(self.system_text(r) for r in reqs))
        self.assertEqual([e["lines"] for e in events(rig, "orientation")], [0])


if __name__ == "__main__":
    unittest.main()
