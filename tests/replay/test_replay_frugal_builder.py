"""Replay: explorer brief into the builder task, child read budget, child prompt size (frugal-roles D7).

An ended explorer run's report is prepended once to the next builder launch (trace explorer_brief).
A builder past childReads warn gets a notice in the result, past deny the call is refused with the
STATUS: stuck hint (trace child_read_budget); a bash test run is never counted. Sizes: the fake
provider's FOREMAN_FAKE_USAGE=size / FOREMAN_FAKE_SIZES logs give per-launch cacheWrite and
system chars (set FOREMAN_MEASURE_OUT=<file> to write the table design/architecture.md quotes).
Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

CFG = {"ceremony": {"launchWait": "block"}}


def all_records(rig):
    return [r for recs in rig.traces().values() for r in recs]


def session_text(rig):
    return [f.read_text("utf-8", "replace") for f in rig.root.rglob("*.jsonl")]


def measure(sizes_file):
    """Per child process (one launch): model, requests, system and tool-schema chars, estimated cacheWrite tokens."""
    rows = {}
    for line in Path(sizes_file).read_text("utf-8").splitlines():
        r = json.loads(line)
        row = rows.setdefault(r["pid"], {"model": r["model"], "requests": 0, "systemChars": r["systemChars"], "toolsChars": r["toolsChars"], "tools": r["tools"], "prev": 0, "writeTokens": 0})
        total = r["systemChars"] + r["toolsChars"] + r["messagesChars"]
        row["writeTokens"] += -(-(total - min(row["prev"], total)) // 4)
        row["prev"] = total
        row["requests"] += 1
    return [{k: v for k, v in row.items() if k != "prev"} for row in rows.values()]


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestFrugalBuilder(ReplayCase):
    def run_flow(self, name, tag, cfg, sizes=False):
        rig = self.rig(name, load_fixture("frugal_builder"), config=cfg)
        (rig.project / "a.txt").write_text("alpha\n", "utf-8")
        extra = {}
        if sizes:
            rig.sizes = rig.root / "sizes.jsonl"
            extra = {"FOREMAN_FAKE_USAGE": "size", "FOREMAN_FAKE_SIZES": str(rig.sizes), "FOREMAN_FAKE_SYSTEM": os.environ.get("FOREMAN_MEASURE_SYSTEM") or str(rig.root / "system")}
        pi = rig.start(env=extra)
        res = tool_results(pi.prompt("[[replay:%s]] go" % tag, timeout=240))
        pi.close()
        return rig, res

    def test_explorer_brief_reaches_the_builder_once(self):
        rig, res = self.run_flow("fb-brief", "sz", CFG, sizes=True)
        self.assertEqual([(n, e) for n, e, _ in res if n == "subagent"], [("subagent", False)] * 3, res)
        self.assertTrue([t for t in session_text(rig) if "[pi-foreman explorer brief]" in t and "a.txt line 1 holds alpha" in t], "no child session carries the explorer brief")
        briefs = [r for r in all_records(rig) if r.get("event") == "explorer_brief"]
        self.assertEqual([(r["role"], r["chars"] > 100) for r in briefs], [("builder", True)])
        out = os.environ.get("FOREMAN_MEASURE_OUT")
        if out:
            Path(out).write_text(json.dumps(measure(rig.sizes), indent=1), "utf-8")

    def test_no_explorer_no_brief(self):
        rig, res = self.run_flow("fb-nobrief", "nobrief", CFG)
        self.assertEqual([(n, e) for n, e, _ in res if n == "subagent"], [("subagent", False)], res)
        self.assertEqual([r for r in all_records(rig) if r.get("event") == "explorer_brief"], [])

    def test_child_read_budget_warn_and_deny(self):
        cfg = {"ceremony": {"launchWait": "block", "childReads": {"builder": {"warn": 2, "deny": 3}}}}
        rig, res = self.run_flow("fb-reads", "reads", cfg)
        self.assertEqual([(n, e) for n, e, _ in res if n == "subagent"], [("subagent", False)], res)
        recs = [(r["role"], r["count"], r["action"]) for r in all_records(rig) if r.get("event") == "child_read_budget"]
        self.assertEqual(recs, [("builder", 2, "warn"), ("builder", 3, "warn"), ("builder", 3, "deny")])
        texts = session_text(rig)
        self.assertTrue([t for t in texts if "[child_read_budget_exceeded]" in t], "no child session carries the deny message")
        self.assertTrue([t for t in texts if "read budget 2 of 3" in t], "no warn notice")


if __name__ == "__main__":
    unittest.main()
