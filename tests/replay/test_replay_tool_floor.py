"""Replay: the foreman tool floor survives another extension's tool reset on resume (ledger item 9).

A synthetic session holds a system record with `toolsRemoved` naming the foreman's routing tools (the shape a plan-mode exit
leaves). Pi re-folds that record on resume and would keep the tools inactive; the adapter appends the registered floor tools back at
session start (trace `tools_floor_restored`), so the first request declares `foreman_triage` and `subagent` again.
Same prerequisites and skips as test_replay.py."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_replay import REASON, ReplayCase  # noqa: E402

REMOVED = ["foreman_triage", "subagent", "foreman_wait", "foreman_checkpoint", "foreman_session_open", "contact_supervisor", "subagent_supervisor", "foreman_ledger"]


def session_lines(cwd):
    head = {"type": "session", "version": 3, "id": "01a00000-0000-7000-8000-000000000001", "timestamp": "2026-11-02T20:00:00.000Z", "cwd": str(cwd)}
    user = {"type": "message", "id": "u0000001", "parentId": None, "timestamp": "2026-11-02T20:00:01.000Z",
            "message": {"role": "user", "content": [{"type": "text", "text": "earlier turn"}], "timestamp": 1793649601000}}
    reset = {"type": "message", "id": "t0000001", "parentId": "u0000001", "timestamp": "2026-11-02T20:29:07.903Z",
             "message": {"role": "system", "content": "", "sections": {}, "timestamp": 1793651347901, "toolsAdded": [], "toolsRemoved": [{"name": n} for n in REMOVED]}}
    return [json.dumps(r) for r in (head, user, reset)]


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestToolFloor(ReplayCase):
    def test_resume_after_a_tools_reset_declares_the_floor(self):
        rig = self.rig("tool-floor", {"foreman": {"tf1": [{"text": "Done."}]}})
        session = rig.root / "resumed.jsonl"
        session.write_text("\n".join(session_lines(rig.project)) + "\n", "utf-8")
        log = rig.root / "frozen.log"
        pi = rig.start(extra_args=["--session", str(session)], env={"FOREMAN_FAKE_FROZEN": "1", "FOREMAN_FAKE_FROZEN_LOG": str(log)})
        pi.session_id(timeout=90)
        pi.prompt("[[replay:tf1]] go", timeout=90)
        pi.close()
        declared = {d["tag"]: d["tools"] for d in (json.loads(l) for l in log.read_text("utf-8").splitlines())}
        self.assertIn("foreman_triage", declared.get("tf1", []), declared)
        self.assertIn("subagent", declared.get("tf1", []), declared)
        events = [r for recs in rig.traces().values() for r in recs]
        restored = [r for r in events if r.get("event") == "tools_floor_restored"]
        self.assertTrue(restored, "no tools_floor_restored trace")


if __name__ == "__main__":
    unittest.main()
