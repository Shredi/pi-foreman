"""Replay: remote close (plan D5, ledger items 9, 42) on the fake provider.

`/foreman close .workflow/result-close.md` over RPC: the close turn (an ordinary user prompt,
cause `close`) writes the result file with `write` through the real permission system and the
triage gate (.workflow/ stays writable); on agent_settled the adapter runs foreman_sync.py (no
repos configured) and shuts the session down, so the process exits by itself.
Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestRemoteClose(ReplayCase):
    def test_foreman_close_writes_result_and_exits(self):
        rig = self.rig("close", load_fixture("close"), config={"sync": {"runRetro": False}}, permissions="baseline")
        pi = rig.start()
        sid = pi.session_id()
        pi.prompt("[[replay:c1]] hello", timeout=60)
        try:  # the session shuts itself down: the record stream ends with the process
            pi.prompt("/foreman close .workflow/result-close.md", timeout=60)
            pi.drain(30)
        except EOFError:
            pass
        deadline = time.time() + 30
        while pi.proc.poll() is None and time.time() < deadline:
            time.sleep(0.2)
        self.assertEqual(pi.proc.poll(), 0, "\n".join(pi.stderr[-15:]))
        res = tool_results(pi.seen)
        self.assertEqual([(n, e) for n, e, _ in res], [("write", False)], res)
        self.assertIn("replay close", (rig.project / ".workflow" / "result-close.md").read_text())
        safe = "".join(c for c in sid if c.isalnum() or c in "-_")
        trace = rig.traces()["trace-" + safe]
        self.assertEqual([r["decision"] for r in trace if r.get("event") == "close"], ["accepted", "turn", "synced", "shutdown"])
        self.assertEqual([r["cause"] for r in trace if r.get("event") == "turn"], ["user", "close"])


if __name__ == "__main__":
    unittest.main()
