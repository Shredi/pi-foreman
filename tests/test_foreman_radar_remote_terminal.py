"""scripts/foreman_radar.py: a remote registry entry carries its terminal address as hcTerminal; a handoff-only child
(no registry entry, no live file) with no recent handoff-dir activity is closed, a recent one and a registry-backed one stay."""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import foreman_radar as fr  # noqa: E402

NOW = 1_800_000_000.0


def stamp(ago):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(NOW - ago))


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        self.adir = Path(tmp) / "agent"
        self.base = self.adir / "pi-foreman"
        (self.base / "state").mkdir(parents=True)

    def registry(self, sessions):
        (self.base / "state" / "sessions.json").write_text(json.dumps({"version": 1, "sessions": sessions}), "utf-8")

    def handoff(self, child, ago):
        d = self.base / "handoffs" / (time.strftime("%Y%m%d-%H%M%S", time.localtime(NOW - ago)) + "-x")
        d.mkdir(parents=True)
        (d / "child").write_text(child + "\n", "utf-8")
        (d / "parent").write_text("p1\n", "utf-8")
        for p in (d / "child", d / "parent", d):
            os.utime(p, (NOW - ago, NOW - ago))
        return d

    def nodes(self):
        return {n["key"]: n for n in self.flat(fr.snapshot(self.adir, NOW, 24.0))}

    def flat(self, ns):
        for n in ns:
            yield n
            yield from self.flat(n.get("children") or [])


class RemoteTerminal(Base):
    def test_remote_entry_gets_its_hc_address(self):
        self.registry([{"label": "demo", "child": "c1", "handoff": "/m/x", "opened": stamp(600), "parent": "", "status": "open",
                        "machine": "alpha", "remoteLive": {"state": "working"}, "hc": {"address": "alpha/t5"}}])
        self.assertEqual(self.nodes()["c1"]["hcTerminal"], "alpha/t5")

    def test_remote_entry_without_an_address_has_none(self):
        self.registry([{"label": "demo", "child": "c1", "handoff": "/m/x", "opened": stamp(600), "parent": "", "status": "open",
                        "machine": "alpha", "remoteLive": {"state": "working"}, "hc": {"address": 7}}])
        self.assertIsNone(self.nodes()["c1"]["hcTerminal"])


class HandoffOnly(Base):
    def test_stale_handoff_only_child_is_closed(self):
        self.handoff("fm-old-1", 9 * 3600)
        n = self.nodes()["fm-old-1"]
        self.assertEqual(n["state"], "closed")

    def test_recent_handoff_only_child_stays(self):
        self.handoff("fm-new-1", 60)
        self.assertNotEqual(self.nodes()["fm-new-1"]["state"], "closed")

    def test_old_dir_with_a_recent_file_stays(self):
        d = self.handoff("fm-busy-1", 9 * 3600)
        (d / "plan.md").write_text("x", "utf-8")
        os.utime(d / "plan.md", (NOW - 30, NOW - 30))
        self.assertNotEqual(self.nodes()["fm-busy-1"]["state"], "closed")

    def test_registry_entry_with_unknown_terminal_stays(self):
        d = self.handoff("c2", 9 * 3600)
        self.registry([{"label": "a", "child": "c2", "handoff": str(d), "opened": stamp(9 * 3600), "parent": "", "status": "open",
                        "hc": {"address": "t9"}}])
        with mock.patch.object(fr, "hc_terminal_addresses", return_value=None), mock.patch.object(fr, "herdr_panes", return_value=None):
            n = self.nodes()["c2"]
        self.assertNotEqual(n["state"], "closed")


if __name__ == "__main__":
    unittest.main()
