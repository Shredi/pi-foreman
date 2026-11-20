"""scripts/foreman_radar.py: a remote registry entry's local attach terminal (`attach.address`) is the node's `attach` field;
without one the field is left out."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import foreman_radar as fr  # noqa: E402
from test_foreman_radar_remote_terminal import NOW, Base, stamp  # noqa: E402


class RemoteAttach(Base):
    def nodes(self):
        symbols = fr.load_symbols()
        flat = []
        def walk(n):
            flat.append(n)
            for c in n["children"]:
                walk(c)
        for r in fr.snapshot(self.adir, NOW, 24.0):
            walk(r)
        return {n["key"]: fr.to_json_node(n, NOW, symbols) for n in flat}

    def entry(self, **extra):
        return {"label": "demo", "child": "c1", "handoff": "/m/x", "opened": stamp(600), "parent": "", "status": "open",
                "machine": "alpha", "remoteLive": {"state": "working"}, "hc": {"address": "alpha/t5"}, **extra}

    def test_attach_address_is_on_the_remote_node(self):
        self.registry([self.entry(attach={"address": "t71"})])
        self.assertEqual(self.nodes()["c1"]["attach"], "t71")

    def test_no_attach_leaves_the_field_out(self):
        self.registry([self.entry()])
        self.assertNotIn("attach", self.nodes()["c1"])

    def test_malformed_attach_leaves_the_field_out(self):
        self.registry([self.entry(attach="t71")])
        self.assertNotIn("attach", self.nodes()["c1"])
        self.registry([self.entry(attach={"address": 7})])
        self.assertNotIn("attach", self.nodes()["c1"])


if __name__ == "__main__":
    unittest.main()
