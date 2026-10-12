"""scripts/foreman_radar.py: a child orchestrator session (registry entry + handoff `parent` file) nests under its parent."""
from __future__ import annotations

import datetime
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

NOW = datetime.datetime(2026, 10, 9, 12, 0, 0, tzinfo=datetime.timezone.utc).timestamp()


def iso(ago):
    return datetime.datetime.fromtimestamp(NOW - ago, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def local_iso(ago):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(NOW - ago))


class SessionTreeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.adir = Path(self.tmp) / "agent"
        self.base = self.adir / "pi-foreman"

    def put_parent(self):
        p = self.base / "state" / "live" / "s-top.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({
            "v": 1, "sessionId": "s-top", "intercomId": "fm-top", "parentIntercom": None, "handoff": None,
            "label": "top", "cwd": "/work/x", "pid": 1, "mode": "tui", "startedAt": iso(3600),
            "heartbeatAt": iso(5), "lastEventAt": iso(12), "state": "working", "runs": []}), "utf-8")

    def put_child(self, status):
        h = self.base / "handoffs" / "20261009-115900-kid"
        h.mkdir(parents=True)
        (h / "parent").write_text("fm-top\n", "utf-8")
        (h / "child").write_text("fm-kid\n", "utf-8")
        reg = self.base / "state" / "sessions.json"
        reg.parent.mkdir(parents=True, exist_ok=True)
        reg.write_text(json.dumps({"version": 1, "sessions": [
            {"label": "kid", "child": "fm-kid", "parent": "", "opened": local_iso(1000), "status": status,
             "handoff": str(h)}]}), "utf-8")

    def test_pending_child_nests_under_parent_as_starting(self):
        self.put_parent()
        self.put_child("pending")
        roots = fr.snapshot(self.adir, NOW, 24.0)
        self.assertEqual([r["name"] for r in roots], ["top"])
        (kid,) = roots[0]["children"]
        self.assertEqual((kid["name"], kid["glyph"]), ("kid", "starting"))
        text = "\n".join(fr.render(roots, NOW, 80, False))
        self.assertIn("top", text)
        self.assertIn("kid", text)
        self.assertLess(text.index("top"), text.index("kid"))

    def test_open_child_is_not_a_root(self):
        self.put_parent()
        self.put_child("open")
        roots = fr.snapshot(self.adir, NOW, 24.0)
        self.assertEqual([r["name"] for r in roots], ["top"])
        self.assertEqual([c["name"] for c in roots[0]["children"]], ["kid"])


if __name__ == "__main__":
    unittest.main()
