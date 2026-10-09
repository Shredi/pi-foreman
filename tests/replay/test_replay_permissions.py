"""Permission layers on the fake provider (safety wave, ledger items 1-4, 27, 29, 35).

Run:  FOREMAN_REPLAY_CACHE=<dir> python -m unittest discover -s tests/replay -v
Needs the permission system (@gotgenes/pi-permission-system 39.0.2), installed on first use
into the replay cache next to pi-subagents. The rigs here use the baseline the installer writes.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestPermissionLayers(ReplayCase):
    def baseline_rig(self, name):
        rig = self.rig(name, load_fixture("permissions"), permissions="baseline")
        (rig.project / ".env").write_text("TOKEN=not-a-real-secret\n", "utf-8")
        (rig.project / "notes.txt").write_text("hello\n", "utf-8")
        return rig

    def test_secret_reads_denied_in_main(self):
        rig = self.baseline_rig("perm-main")
        pi = rig.start()
        res = tool_results(pi.prompt("[[replay:m1]] go", timeout=60))
        pi.close()
        self.assertEqual([(n, e) for n, e, _ in res], [("bash", True), ("read", True), ("bash", True), ("read", False)])
        for _, _, text in res[:3]:
            self.assertIn("denied by the permission policy", text)
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
        events = [r for recs in rig.traces().values() for r in recs if r.get("event") == "overlay"]
        self.assertTrue(any(r.get("toolFamily") == "bash" and r.get("decision") == "deny" for r in events), events)

    def test_permission_ask_raises_one_herdr_block(self):
        rig = self.baseline_rig("perm-herdr")
        herdr = rig.root / "herdr.jsonl"
        pi = rig.start(env={"FOREMAN_FAKE_HERDR": str(herdr), "HERDR_ENV": "1"})
        recs = pi.prompt("[[replay:a1]] go", answers=[{"value": "Yes"}], timeout=60)
        pi.close()
        dialogs = [r for r in recs if r.get("type") == "extension_ui_request" and r.get("method") in ("select", "confirm")]
        self.assertEqual(len(dialogs), 1, dialogs)
        blocked = [json.loads(line) for line in herdr.read_text("utf-8").splitlines()]
        self.assertEqual(blocked, [{"active": True, "label": "bash uname"}, {"active": False}])

    def test_child_ask_is_forwarded_to_the_parent(self):
        rig = self.baseline_rig("perm-ask")
        pi = rig.start()
        pi.prompt("[[replay:c2]] go", timeout=60)
        notice, recs = pi.wait_child_notify(timeout=90, answers=[{"confirmed": True}, {"value": "Yes"}, {"value": "Yes"}])
        pi.close()
        dialogs = [r for r in recs if r.get("type") == "extension_ui_request" and r.get("method") in ("select", "confirm")]
        self.assertTrue(dialogs, "no approval dialog reached the parent: %s" % notice)
        self.assertIn("uname", repr(dialogs[0]))


if __name__ == "__main__":
    unittest.main()
