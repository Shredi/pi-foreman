"""Permission layers on the fake provider (safety wave, ledger items 1-4, 27, 29, 35).

Run:  python -m unittest discover -s tests/replay -v
The rigs here run the foreman's gate.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import PROVIDER_A, load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestPermissionLayers(ReplayCase):
    def baseline_rig(self, name, **kw):
        rig = self.rig(name, load_fixture("permissions"), permissions="baseline", **kw)
        (rig.project / ".env").write_text("TOKEN=not-a-real-secret\n", "utf-8")
        (rig.project / "notes.txt").write_text("hello\n", "utf-8")
        return rig

    def test_secret_reads_denied_in_main(self):
        rig = self.baseline_rig("perm-main")
        pi = rig.start()
        res = tool_results(pi.prompt("[[replay:m1]] go", timeout=60))
        pi.close()
        self.assertEqual([(n, e) for n, e, _ in res], [("bash", True), ("read", True), ("bash", True), ("read", False)])
        # item 23: old text "denied by the permission policy" (package/overlay); the rig still loads the package's baseline
        # path deny for the bare name `.env` (the gate floor secret-path leaves bare names to path rules), so the deny text is its own
        for _, _, text in res[:3]:
            self.assertRegex(text, r"(?i)denied")
            self.assertNotIn("not-a-real-secret", text)
        self.assertIn("hello", res[3][2])

    def test_secret_read_denied_in_child(self):
        rig = self.baseline_rig("perm-child")
        pi = rig.start()
        res = tool_results(pi.prompt("[[replay:c1]] go", timeout=60))
        self.assertEqual([(n, e) for n, e, _ in res], [("subagent", False)])
        notice, _ = pi.wait_child_notify(timeout=90)
        pi.close()
        self.assertIn("child: secret read finished", notice)
        self.assertNotIn("not-a-real-secret", notice)
        # item 23: old: an overlay deny record; new: the child's session carries a deny text and never the secret
        text = "\n".join(p.read_text("utf-8", "replace") for p in rig.agent.rglob("*.jsonl"))
        self.assertRegex(text, r"(?i)denied by policy|floor-secret-path|secret or key path")
        self.assertNotIn("not-a-real-secret", text)

    # Retired (item 23): test_permission_ask_raises_one_herdr_block asserted the permission package's herdr block signal
    # for its ask dialog; the gate has no herdr block (gate dialogs are covered in test_replay_review.py).

    def test_child_ask_goes_to_the_parent_dialog(self):
        # item 23: old: the package forwarded a child's ask to the parent as a dialog. Owner ruling (gate.childAsk parent): the
        # parent's pane shows the child's ask as a dialog and the parent's deny reaches the child (old assertion: no dialog and
        # "Children cannot answer asks"; that text stays for a headless parent).
        rig = self.baseline_rig("perm-ask", config={"providers": {PROVIDER_A: {"review": {"model": "%s/review-ask" % PROVIDER_A}}}})
        pi = rig.start()
        # the subagent launch itself is a payload tool and goes to review (review-ask here): the owner approves that one dialog
        pi.prompt("[[replay:c2]] go", answers=[{"value": "allow once"}], timeout=60)
        notice, recs = pi.wait_child_notify(timeout=90, answers=[{"value": "deny with reason"}, {"value": "scripted no"}])
        pi.close()
        dialogs = [r for r in recs if r.get("type") == "extension_ui_request" and r.get("method") == "select" and "asks" in str(r.get("title"))]
        self.assertEqual(len(dialogs), 1, dialogs)
        self.assertIn("package-install", dialogs[0]["title"])
        text = "\n".join(p.read_text("utf-8", "replace") for p in rig.agent.rglob("*.jsonl"))
        self.assertIn("denied by the parent", text)
        self.assertNotIn("Children cannot answer asks", text)


if __name__ == "__main__":
    unittest.main()
