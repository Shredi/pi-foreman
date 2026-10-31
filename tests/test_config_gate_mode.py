"""gate.mode (r76, temporary): only the user layer and the overlay set "floors-only"; the project and session layers drop it."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402


class GateModeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(os.path.realpath(self.tmp.name))
        self.agent = root / "agent"
        self.agent.mkdir()
        self.project = root / "proj"
        (self.project / ".pi").mkdir(parents=True)
        (self.project / ".git").mkdir()

    def load(self, proj=None, l2=None, session=None):
        if l2 is not None:
            (self.agent / "foreman.json").write_text(json.dumps(l2))
        if proj is not None:
            (self.project / ".pi" / "foreman.json").write_text(json.dumps(proj))
        return fc.load_config(agent_dir=str(self.agent), project_dir=str(self.project), trusted_project=True,
                              session_json=json.dumps(session) if session is not None else None)

    def mode(self, res):
        return (res["config"].get("gate") or {}).get("mode", "full")

    def test_project_layer_cannot_set_floors_only(self):
        res = self.load(proj={"gate": {"mode": "floors-only"}})
        self.assertEqual(self.mode(res), "full")

    def test_project_layer_cannot_override_user_full(self):
        res = self.load(l2={"gate": {"tmpAccess": True}}, proj={"gate": {"mode": "floors-only"}})
        self.assertEqual(self.mode(res), "full")

    def test_session_layer_cannot_set_floors_only(self):
        res = self.load(session={"gate": {"mode": "floors-only"}})
        self.assertEqual(self.mode(res), "full")

    def test_user_layer_keeps_floors_only(self):
        res = self.load(l2={"gate": {"mode": "floors-only"}})
        self.assertEqual(self.mode(res), "floors-only")
        self.assertEqual(res["errors"], [])


if __name__ == "__main__":
    unittest.main()
