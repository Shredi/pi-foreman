"""scripts/foreman_radar.py: a remote ask shows the number and topic of the mirrored ask.md header, never the notice seq."""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import foreman_radar as fr  # noqa: E402

NOW = 1_800_000_000.0


class RemoteAskTest(unittest.TestCase):
    def node(self, ask):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        adir = Path(tmp) / "agent"
        reg = adir / "pi-foreman" / "state" / "sessions.json"
        reg.parent.mkdir(parents=True)
        opened = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(NOW - 600))
        reg.write_text(json.dumps({"version": 1, "sessions": [
            {"label": "demo", "child": "c1", "handoff": str(adir / "m" / "x"), "opened": opened, "parent": "", "status": "open",
             "machine": "alpha", "remoteLive": {"state": "working"}, "ask": ask}]}), "utf-8")
        (node,) = fr.snapshot(adir, NOW, 24.0)
        return node

    def test_n_and_topic_come_from_the_header_not_the_seq(self):
        node = self.node({"seq": 9, "n": 2, "topic": "db choice", "path": "/m/x/ask.md"})
        self.assertEqual(node["state"], "ask")
        self.assertEqual(node["asks"], [{"n": 2, "topic": "db choice"}])

    def test_without_a_stored_n_no_number_is_shown(self):
        node = self.node({"seq": 9, "path": "/m/x/ask.md"})
        self.assertEqual(node["state"], "ask")
        self.assertNotIn("asks", node)

    def test_a_topic_less_ask_falls_back_to_remote(self):
        self.assertEqual(self.node({"seq": 9, "n": 1})["asks"], [{"n": 1, "topic": "remote"}])


if __name__ == "__main__":
    unittest.main()
