"""scripts/review_log_stats.py on a synthetic review log."""
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
USER = {"kind": "user", "via": "dialog"}


def rec(event, rid=None, **kw):
    r = {"extension": "pi-permission-system", "stream": "review", "event": event}
    if rid:
        r["requestId"] = rid
    r.update(kw)
    return r


LOG = [
    rec("forwarded_permission.serving_started", sessionId="S1"),
    # 1: reviewed allow, no human
    rec("permission_request.waiting", "r1", command=SECRET),
    rec("foreman_review.decision", "r1", sessionId="S1", model="p/m", verdict="allow"),
    rec("permission_request.approved", "r1", decidedBy={"kind": "authorizer", "name": "foreman-review", "verdict": "allow"}, command=SECRET),
    # 2: reviewed defer, human approves
    rec("permission_request.waiting", "r2", command=SECRET),
    rec("foreman_review.decision", "r2", sessionId="S1", model="p/m", verdict="defer"),
    rec("permission_request.approved", "r2", decidedBy=USER, resolution="approved"),
    # 3: no review model, human denies
    rec("permission_request.waiting", "r3"),
    rec("foreman_review.decision", "r3", sessionId="S1", model=None, verdict="defer", outcome="no-model"),
    rec("permission_request.denied", "r3", decidedBy=USER),
    # 4: forwarded from a child: child lines + parent lines, one ask
    rec("permission_request.waiting", "r4"),
    rec("forwarded_permission.prompted", "r4", requesterSessionId="C1", targetSessionId="S1"),
    rec("foreman_review.decision", "r4", sessionId="S1", model="p/m", verdict="deny"),
    rec("permission_request.denied", "r4", forwarded=True, requesterSessionId="C1", decidedBy={"kind": "authorizer", "name": "foreman-review", "verdict": "deny"}),
    rec("permission_request.denied", "r4", decidedBy={"kind": "forwarded", "decision": {"kind": "authorizer"}}),
    # 5: forwarded, human approves on the parent; child records the nested user decision
    rec("forwarded_permission.prompted", "r5", targetSessionId="S2"),
    rec("permission_request.approved", "r5", forwarded=True, decidedBy=USER),
    rec("permission_request.approved", "r5", decidedBy={"kind": "forwarded", "decision": USER}),
    # 6: ai-guard verdict, another session unknown
    rec("permission_request.waiting", "r6"),
    rec("ai_guard.decision", "r6", verdict="allow", target=SECRET),
    rec("permission_request.approved", "r6", decidedBy={"kind": "authorizer", "name": "ai-guard"}),
]


class StatsTest(unittest.TestCase):
    def test_counts_per_session_once_per_ask(self):
        out = rls.stats(LOG)
        self.assertEqual(out["S1"], {"asks": 4, "human_approved": 1, "human_denied": 1, "review_allow": 1,
                                     "review_deny": 1, "review_defer": 1, "forwarded": 1})
        self.assertEqual(out["S2"], {"asks": 1, "human_approved": 1, "human_denied": 0, "review_allow": 0,
                                     "review_deny": 0, "review_defer": 0, "forwarded": 1})
        self.assertEqual(out["unknown"]["review_allow"], 1)

    def test_cli_never_prints_commands(self):
        d = tempfile.mkdtemp(prefix="pf-rls-")
        try:
            log = Path(d) / "review.jsonl"
            log.write_text("\n".join(json.dumps(r) for r in LOG) + "\nnot json\n", "utf-8")
            for extra in ([], ["--json"]):
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    self.assertEqual(rls.main([str(log)] + extra), 0)
                self.assertNotIn(SECRET, buf.getvalue())
                self.assertIn("S1", buf.getvalue())
        finally:
            shutil.rmtree(d)


if __name__ == "__main__":
    unittest.main()
