"""Replay: closing an opened session over intercom (plan Part B, ledger items 14, 16, 18).

The child runs with PI_FOREMAN_HANDOFF_DIR (its `parent` file names the parent) and the child id
from the registry as PI_INTERCOM_STABLE_ID; the parent is a second foreman with that parent id.
A close from a sender other than the one in the parent file is refused with a reply; after the
parent file is re-pointed to the sender, the same request closes the child, which replies
`foreman:closed <result path>` before it exits; the parent's registry entry records it.
Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import json
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

CHILD = "fm-demo-abc123"


def drain_until(pi, needle, seconds):
    """Records until one mentions `needle` (or the time is up); the records seen."""
    out, deadline = [], time.time() + seconds
    while time.time() < deadline:
        try:
            out += pi.drain(2)
        except EOFError:
            break
        if needle in json.dumps(out):
            break
    return out


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestSessionClose(ReplayCase):
    def test_parent_file_decides_the_sender_and_the_close_is_acknowledged(self):
        script = load_fixture("close")
        script["foreman"]["w1"] = [{"text": "Waiting."}]
        script["foreman"]["p1"] = [{"text": "Parent ready."}]
        send = [{"tools": [{"name": "intercom", "arguments": {"action": "send", "to": CHILD, "message": "foreman:close .workflow/result-close.md"}}]}, {"text": "sent"}]
        script["foreman"]["p2"] = send
        script["foreman"]["p3"] = send
        rig = self.rig("sessclose", script, config={"sync": {"runRetro": False}}, permissions="baseline", intercom=True)
        handoff = rig.root / "handoff"
        handoff.mkdir()
        (handoff / "parent").write_text("someone-else\n", "utf-8")
        rig.state_dir.mkdir(parents=True, exist_ok=True)
        (rig.state_dir / "sessions.json").write_text(json.dumps({"version": 1, "sessions": [
            {"label": "demo", "child": CHILD, "parent": "parent-x", "handoff": str(handoff), "status": "open"}]}), "utf-8")
        child = rig.start(env={"PI_FOREMAN_HANDOFF_DIR": str(handoff), "PI_INTERCOM_STABLE_ID": CHILD})
        sid = child.session_id()
        child.prompt("[[replay:w1]] wait", timeout=90)
        parent = rig.start(env={"PI_INTERCOM_STABLE_ID": "parent-x"})
        parent.prompt("[[replay:p1]] hi", timeout=90)

        # Wrong sender: the parent file names someone else; the child refuses and replies.
        sent = tool_results(parent.prompt("[[replay:p2]] send", timeout=90))
        self.assertEqual([(n, e) for n, e, _ in sent], [("intercom", False)], sent)
        seen = drain_until(parent, "close refused", 30)
        self.assertIn("pi-foreman: close refused: the sender is not the parent recorded at spawn", json.dumps(seen))
        child.drain(5)  # the child's wake turn after the refused message
        self.assertIsNone(child.proc.poll())

        # Re-pointed parent file: the same sender is now accepted.
        child.prompt("[[replay:c1]] hello", timeout=90)
        (handoff / "parent").write_text("parent-x\n", "utf-8")
        sent = tool_results(parent.prompt("[[replay:p3]] send", timeout=90))
        self.assertEqual([(n, e) for n, e, _ in sent], [("intercom", False)], sent)
        try:
            child.drain(30)
        except EOFError:
            pass
        deadline = time.time() + 30
        while child.proc.poll() is None and time.time() < deadline:
            time.sleep(0.2)
        self.assertEqual(child.proc.poll(), 0, "\n".join(child.stderr[-15:]))
        result = (rig.project / ".workflow" / "result-close.md").resolve()
        self.assertIn("replay close", result.read_text())
        seen = drain_until(parent, "foreman:closed", 30)
        self.assertIn("foreman:closed %s" % result, json.dumps(seen).replace("\\\\", "\\"))
        safe = "".join(c for c in sid if c.isalnum() or c in "-_")
        trace = rig.traces()["trace-" + safe]
        self.assertEqual([r["decision"] for r in trace if r.get("event") == "close"], ["refused", "accepted", "turn", "synced", "shutdown"])
        deadline = time.time() + 15
        while time.time() < deadline:
            entry = json.loads((rig.state_dir / "sessions.json").read_text("utf-8"))["sessions"][0]
            if entry.get("status") == "closed":
                break
            time.sleep(0.3)
        self.assertEqual((entry["status"], Path(entry["result"]).resolve()), ("closed", result))


if __name__ == "__main__":
    unittest.main()
