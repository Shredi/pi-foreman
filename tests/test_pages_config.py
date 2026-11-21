"""pages.server in the layered config: defaults, the user layer sets every key, the project and session
layers may only set enabled to false (docs/pages.md)."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402

DEFAULTS = {"enabled": True, "port": 47317, "bind": "127.0.0.1", "baseUrl": ""}


class PagesServerLayersTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(os.path.realpath(self.tmp.name))
        self.agent = root / "agent"
        self.agent.mkdir()
        self.project = root / "proj"
        (self.project / ".pi").mkdir(parents=True)
        (self.project / ".git").mkdir()

    def load(self, proj=None, session=None, l2=None):
        if l2 is not None:
            (self.agent / "foreman.json").write_text(json.dumps(l2))
        if proj is not None:
            (self.project / ".pi" / "foreman.json").write_text(json.dumps(proj))
        return fc.load_config(agent_dir=str(self.agent), project_dir=str(self.project), trusted_project=True,
                              l3_paths=[], session_json=json.dumps(session) if session is not None else None)

    def server(self, res):
        return res["config"]["pages"]["server"]

    def test_defaults(self):
        self.assertEqual(self.server(self.load()), DEFAULTS)

    def test_user_layer_sets_every_key(self):
        res = self.load(l2={"pages": {"server": {"enabled": False, "port": 50000, "bind": "100.64.0.1", "baseUrl": "https://box.example"}}})
        self.assertEqual(self.server(res), {"enabled": False, "port": 50000, "bind": "100.64.0.1", "baseUrl": "https://box.example"})
        self.assertEqual(res["errors"], [])

    def test_project_and_session_cannot_set_port_bind_or_base_url(self):
        for layer in ("project", "session"):
            data = {"pages": {"server": {"port": 1234, "bind": "0.0.0.0", "baseUrl": "http://evil.example"}}}
            res = self.load(proj=data) if layer == "project" else self.load(session=data)
            self.assertEqual(self.server(res), DEFAULTS, layer)
            text = "\n".join(res["warnings"])
            for key in ("port", "bind", "baseUrl"):
                self.assertIn("%s pages.server.%s ignored" % (layer, key), text)

    def test_project_and_session_cannot_keep_a_user_value_changed(self):
        l2 = {"pages": {"server": {"port": 50000, "bind": "100.64.0.1", "baseUrl": "https://box.example"}}}
        res = self.load(l2=l2, proj={"pages": {"server": {"port": 1, "bind": "0.0.0.0", "baseUrl": "x"}}},
                        session={"pages": {"server": {"port": 2, "bind": "::", "baseUrl": "y"}}})
        self.assertEqual(self.server(res), {"enabled": True, "port": 50000, "bind": "100.64.0.1", "baseUrl": "https://box.example"})

    def test_project_and_session_can_set_enabled_false_only(self):
        self.assertFalse(self.server(self.load(proj={"pages": {"server": {"enabled": False}}}))["enabled"])
        self.assertFalse(self.server(self.load(session={"pages": {"server": {"enabled": False}}}))["enabled"])

    def test_project_cannot_switch_it_back_on(self):
        res = self.load(l2={"pages": {"server": {"enabled": False}}}, proj={"pages": {"server": {"enabled": True}}})
        self.assertFalse(self.server(res)["enabled"])
        self.assertIn("project pages.server.enabled", "\n".join(res["warnings"]))


if __name__ == "__main__":
    unittest.main()
