"""scripts/review_log_stats.py on a synthetic gate log."""
from __future__ import annotations

import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import review_log_stats as rls  # noqa: E402

SECRET = "cat-the-secret-command"
_n = [0]


def rec(session, layer, verdict, **kw):
    _n[0] += 1
    r = {"id": "%012x" % _n[0], "ts": "2026-10-27T10:00:00.000Z", "session": session, "kind": "owner", "role": "foreman",
         "tool": "bash", "layer": layer, "verdict": verdict, "rule": "r", "reason": "", "shape": SECRET, "cwdHash": "abc"}
    r.update(kw)
    return r


DUP = rec("S1", "floor", "deny", rule="git-push")
LOG = [
    DUP,
    DUP,  # the same id twice (a rotated log read twice) counts once
    rec("S1", "default", "allow"),
    rec("S1", "review", "allow", model="p/m", latencyMs=120),
    rec("S1", "review", "deny", model="p/m"),
    rec("S1", "review", "ask", model="p/m"),
    rec("S1", "review", "unreachable", reason="timeout"),
    rec("S1", "cache", "allow", cached=True),
    rec("S1", "dialog", "allow", rule="selfmod", reason="approved"),
    rec("S1", "dialog", "deny", rule="selfmod", reason="denied"),
    rec("S1", "dialog", "deny", rule="selfmod", reason="no-dialog"),
    rec("C1", "floor", "deny", kind="child", role="builder"),
    rec("C1", "review", "allow", kind="headless", role="builder", model="p/m"),
    {"layer": "default", "verdict": "allow"},  # a record without id or session
]


class StatsTest(unittest.TestCase):
    def test_counts_per_session_once_per_record(self):
        out = rls.stats(LOG)
        self.assertEqual(out["S1"], {"decisions": 10, "floor_deny": 1, "default_allow": 1, "review_allow": 1,
                                     "review_deny": 1, "review_ask": 1, "review_unreachable": 1, "cached": 1,
                                     "human_approved": 1, "human_denied": 1, "no_dialog": 1, "child": 0})
        self.assertEqual(out["C1"]["decisions"], 2)
        self.assertEqual(out["C1"]["child"], 2)
        self.assertEqual(out["C1"]["floor_deny"], 1)
        self.assertEqual(out["C1"]["review_allow"], 1)
        self.assertEqual(out["unknown"]["default_allow"], 1)

    def test_cli_never_prints_commands(self):
        d = tempfile.mkdtemp(prefix="pf-rls-")
        try:
            log = Path(d) / "log.jsonl"
            log.write_text("\n".join(json.dumps(r) for r in LOG) + "\nnot json\n", "utf-8")
            for extra in ([], ["--json"]):
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    self.assertEqual(rls.main([str(log)] + extra), 0)
                self.assertNotIn(SECRET, buf.getvalue())
                self.assertIn("S1", buf.getvalue())
        finally:
            shutil.rmtree(d)

    def test_missing_log_exits_2(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(rls.main(["/nonexistent/pf-rls/log.jsonl"]), 2)


if __name__ == "__main__":
    unittest.main()
