"""Replay: launch fields `reads` and `install` reach the child through the launch binding (R46 items 5 and 8).

`reads: 4` raises the builder's read deny from the configured 3 to 4 (warn moves with it: 3 of 4, no deny) and the
trace `child_read_budget` carries the allowance. A child `npm ci` outside an owned worktree asks either way, but the
refusal names the `install: true` launch flag only when the launch did not set it.
Same prerequisites and skips as test_replay.py."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

CFG = {"ceremony": {"launchWait": "block", "childReads": {"builder": {"warn": 2, "deny": 3}}}}
HINT = "relaunch you with the launch flag `install: true`"


def all_records(rig):
    return [r for recs in rig.traces().values() for r in recs]


def session_text(rig):
    return "\n".join(f.read_text("utf-8", "replace") for f in rig.root.rglob("*.jsonl"))


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestR46Launch(ReplayCase):
    def run_flow(self, name, tag):
        rig = self.rig(name, load_fixture("r46_launch"), config=CFG)
        (rig.project / "a.txt").write_text("alpha\n", "utf-8")
        pi = rig.start()
        res = tool_results(pi.prompt("[[replay:%s]] go" % tag, timeout=240))
        pi.close()
        self.assertEqual([(n, e) for n, e, _ in res if n == "subagent"], [("subagent", False)], res)
        return rig

    def test_reads_field_raises_the_deny(self):
        rig = self.run_flow("r46-reads", "rd")
        recs = [(r["role"], r["count"], r["action"], r["allowance"]) for r in all_records(rig) if r.get("event") == "child_read_budget"]
        self.assertEqual(recs, [("builder", 3, "warn", 4), ("builder", 4, "warn", 4)])
        self.assertNotIn("[child_read_budget_exceeded]", session_text(rig))

    def test_npm_ci_refusal_names_the_install_flag(self):
        rig = self.run_flow("r46-noinstall", "noinst")
        self.assertIn(HINT, session_text(rig))

    def test_install_launch_does_not_get_the_hint(self):
        rig = self.run_flow("r46-install", "inst")
        text = session_text(rig)
        self.assertIn("npm ci needs approval for a child", text)
        self.assertNotIn(HINT, text)


if __name__ == "__main__":
    unittest.main()
