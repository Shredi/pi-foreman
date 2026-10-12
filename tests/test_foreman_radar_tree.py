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

    def test_handoff_only_child_gets_its_handoff_path(self):
        # child known only from its handoff dir (no registry entry): radar must not crash (NameError on `base`, 12.10.)
        self.put_parent()
        h = self.base / "handoffs" / "20261009-115900-orphan"
        h.mkdir(parents=True)
        (h / "parent").write_text("fm-top\n")
        (h / "child").write_text("orphan\n")
        roots = fr.snapshot(self.adir, NOW, 24.0)
        (kid,) = roots[0]["children"]
        self.assertEqual(kid["name"], "orphan")
        self.assertEqual(kid["path"], str(h))


class ChildPresenceTest(unittest.TestCase):
    """R3b point 7: a working child is never shown as lost under its parent (registry/presence gap)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.adir = Path(self.tmp) / "agent"
        self.base = self.adir / "pi-foreman"
        self.h = self.base / "handoffs" / "20261009-115900-kid"
        self.h.mkdir(parents=True)
        (self.h / "parent").write_text("fm-top\n", "utf-8")
        (self.h / "child").write_text("fm-kid-abc123\n", "utf-8")
        live = self.base / "state" / "live"
        live.mkdir(parents=True)
        (live / "s-top.json").write_text(json.dumps({
            "v": 1, "sessionId": "s-top", "intercomId": "fm-top", "parentIntercom": None, "handoff": None,
            "label": "top", "cwd": "/work/x", "pid": 1, "mode": "tui", "startedAt": iso(3600),
            "heartbeatAt": iso(5), "lastEventAt": iso(12), "state": "working", "runs": []}), "utf-8")

    def put_child_live(self, intercom_id):
        # the child's own published id (not the registry child id), its handoff dir and its parent
        (self.base / "state" / "live" / "s-kid.json").write_text(json.dumps({
            "v": 1, "sessionId": "s-kid", "intercomId": intercom_id, "parentIntercom": "fm-top", "handoff": str(self.h),
            "label": "kid", "cwd": "/work/kid", "pid": 2, "mode": "tui", "startedAt": iso(900),
            "heartbeatAt": iso(5), "lastEventAt": iso(6), "state": "working", "runs": []}), "utf-8")

    def put_registry(self, status):
        reg = self.base / "state" / "sessions.json"
        reg.parent.mkdir(parents=True, exist_ok=True)
        reg.write_text(json.dumps({"version": 1, "sessions": [
            {"label": "kid", "child": "fm-kid-abc123", "parent": "fm-top", "opened": local_iso(1000),
             "status": status, "handoff": str(self.h)}]}), "utf-8")

    def test_working_child_under_parent_is_not_a_lost_twin(self):
        # R3 shape: parent live node; registry entry open for 1000 s; the child's live state working
        self.put_child_live("pi-kid-1")
        self.put_registry("open")
        roots = fr.snapshot(self.adir, NOW, 24.0)
        self.assertEqual([r["name"] for r in roots], ["top"])
        self.assertEqual([(c["name"], c["glyph"]) for c in roots[0]["children"]], [("kid", "working")])
        text = "\n".join(fr.render(roots, NOW, 80, False))
        self.assertNotIn("lost", text)
        # node rows only: the summary header carries a `✗ 0` count
        rows = [ln for ln in text.splitlines() if "top" in ln or "kid" in ln]
        self.assertEqual(len(rows), 2)
        for ln in rows:
            self.assertNotIn("✗", ln)

    def test_open_entry_with_a_result_and_no_live_file_is_idle_not_lost(self):
        (self.h / "result.md").write_text("# done\n", "utf-8")
        self.put_registry("open")
        roots = fr.snapshot(self.adir, NOW, 24.0)
        (kid,) = roots[0]["children"]
        self.assertEqual((kid["glyph"], kid["state"]), ("idle", "idle"))

    def test_open_entry_without_result_and_no_live_file_stays_lost(self):
        self.put_registry("open")
        roots = fr.snapshot(self.adir, NOW, 24.0)
        (kid,) = roots[0]["children"]
        self.assertEqual(kid["glyph"], "lost")


if __name__ == "__main__":
    unittest.main()
