import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class HarnessToolsAllowTest(unittest.TestCase):
    def test_children_role_tool_lists_hold_no_subagents_enable(self):
        roles = json.loads((ROOT / "config" / "foreman.defaults.json").read_text())["roles"]
        for name, r in roles.items():
            self.assertNotIn("subagents_enable", r.get("tools", []), name)


if __name__ == "__main__":
    unittest.main()
