"""agent_session names a session by its file basename, not by substring."""
import importlib.util
import sys
import unittest
from pathlib import Path

SIDEBAR = Path(__file__).resolve().parent.parent / "integrations" / "herdr" / "pi-foreman-sidebar" / "sidebar.py"
spec = importlib.util.spec_from_file_location("sidebar_match", SIDEBAR)
sidebar = importlib.util.module_from_spec(spec)
sys.modules["sidebar_match"] = sidebar
spec.loader.exec_module(sidebar)


class SessionNames(unittest.TestCase):
    def test_exact_id_not_substring(self):
        self.assertFalse(sidebar.session_names("/a/pi/s-10.jsonl", "s-1"))
        self.assertFalse(sidebar.session_names("/a/s-1/x/s-10.jsonl", "s-1"))
        self.assertTrue(sidebar.session_names("/a/pi/s-1.jsonl", "s-1"))
        self.assertTrue(sidebar.session_names("/a/pi/2026-01-01T00-00-00_s-1.jsonl", "s-1"))
        self.assertFalse(sidebar.session_names("/a/pi/2026_s-10.jsonl", "s-1"))
        self.assertFalse(sidebar.session_names(None, "s-1"))
        self.assertFalse(sidebar.session_names("/a/s-1.jsonl", ""))

    def test_join_does_not_take_a_pane_of_a_longer_id(self):
        node = {"kind": "session", "sid": "s-1", "key": "k", "state": "done", "paneId": "w1:p1", "children": [],
                "pid": None}
        agents = [{"pane_id": "w1:p1", "agent": "pi", "agent_session": "/a/pi/s-10.jsonl"}]
        self.assertNotIn("k", sidebar.join([node], agents))
        agents[0]["agent_session"] = "/a/pi/s-1.jsonl"
        self.assertEqual(sidebar.join([node], agents).get("k"), "w1:p1")


if __name__ == "__main__":
    unittest.main()
