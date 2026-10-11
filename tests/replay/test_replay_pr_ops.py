"""Replay: pr_checks and pr_watch through the real Pi tool path against a fake gh (PR tools, ledger item 24).

The fake gh (tests/fixtures/fake_pr_host.py behind sh and .cmd shims, first on PATH) reports one pending
check. The foreman reads it with pr_checks, then starts pr_watch (tools.prWatchSeconds 5). The watch polls
the host again while the session lives, and session shutdown clears it: the host sees no call afterwards.
The trace holds `tool_pack` for both tools and `pr_watch` outcome `started`, and never the PR number.
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
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "fixtures"))
from driver import load_fixture, shape, tool_results  # noqa: E402
from pr_host_shims import make_bin  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

KEYS = ("event", "pack", "op", "outcome")
CHECKS = [{"name": "build", "state": "PENDING", "bucket": "pending", "link": "https://example.com/run/1",
           "startedAt": "2026-10-11T10:00:00Z", "completedAt": None}]


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestPrOps(ReplayCase):
    def test_checks_then_watch_and_shutdown_clears(self):
        rig = self.rig("props", load_fixture("pr_ops"), config={"tools": {"prWatchSeconds": 5}})
        host = rig.root / "host"
        host.mkdir()
        (host / "scenario.json").write_text(json.dumps({"gh pr checks": {"stdout": json.dumps(CHECKS), "exit": 8}}), "utf-8")
        calls = host / "calls.jsonl"
        bin_dir = make_bin(str(rig.root), ["gh"])
        pi = rig.start(env={"PATH": bin_dir + os.pathsep + rig.env()["PATH"], "FAKE_PR_HOST_DIR": str(host)})
        sid = pi.session_id()
        res = tool_results(pi.prompt("[[replay:p1]] start", timeout=60))
        self.assertEqual([(n, e) for n, e, _ in res], [("pr_checks", False), ("pr_watch", False)], res)
        self.assertIn('"pending"', res[0][2])
        self.assertIn('"watching":true', res[1][2])

        def count():
            return len(calls.read_text("utf-8").splitlines()) if calls.exists() else 0

        deadline = time.time() + 30
        before = count()
        while count() <= before and time.time() < deadline:
            time.sleep(0.5)
        self.assertGreater(count(), before, "the watch never polled the host")
        pi.close()
        after = count()
        time.sleep(7)
        self.assertEqual(count(), after, "the watch kept polling after shutdown")
        safe = "".join(c for c in sid if c.isalnum() or c in "-_")
        trace = rig.traces()["trace-" + safe]
        ev = [r for r in trace if r.get("event") in ("tool_pack", "pr_watch")]
        self.assertEqual(shape(ev, KEYS), [
            {"event": "tool_pack", "pack": "git", "op": "pr_checks"},
            {"event": "tool_pack", "pack": "git", "op": "pr_watch"},
            {"event": "pr_watch", "outcome": "started"},
        ])
        self.assertNotIn('"number"', json.dumps(ev))
        self.golden("pr_ops", {"session": shape(ev, KEYS)})


if __name__ == "__main__":
    unittest.main()
