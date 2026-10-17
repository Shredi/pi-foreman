import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import permissions_gen as pg  # noqa: E402

OWNED = {"scratchRoot": "/tmpx/pi-foreman-scratch", "npmRoot": "/opt/npm/lib/node_modules"}
HARNESS = ("subagents_enable", "bg_status", "bg_logs", "bg_kill", "bg_wait", "foreman_triage", "foreman_ledger", "foreman_wait", "foreman_move", "foreman_copy")


class HarnessToolsAllowTest(unittest.TestCase):
    def test_not_on_the_chair_allow_list_escalated_is_a_pre_allow(self):
        """The dialog "not on the chair allow list, escalated" came from a missing tool-level allow."""
        with tempfile.TemporaryDirectory() as d:
            p = pg.render({}, Path(d), owned=OWNED)["permission"]
        for t in HARNESS:
            self.assertEqual(p[t], "allow", t)

    def test_children_role_tool_lists_hold_no_subagents_enable(self):
        roles = json.loads((ROOT / "config" / "foreman.defaults.json").read_text())["roles"]
        for name, r in roles.items():
            self.assertNotIn("subagents_enable", r.get("tools", []), name)


if __name__ == "__main__":
    unittest.main()
