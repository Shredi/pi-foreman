"""gate.readonlyClear has no effect (the judge step for read-only roles was removed) but stays a known key: it loads without a warning in the user layer and in the project layer, as gate.askTimeoutMs does."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402


class ReadonlyClearTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(os.path.realpath(self.tmp.name))
        self.agent = root / "agent"
        self.agent.mkdir()
        self.project = root / "proj"
        (self.project / ".pi").mkdir(parents=True)
        (self.project / ".git").mkdir()

    def load(self, proj=None, user=None):
        if user is not None:
            (self.agent / "foreman.json").write_text(json.dumps(user))
        if proj is not None:
            (self.project / ".pi" / "foreman.json").write_text(json.dumps(proj))
        return fc.load_config(agent_dir=str(self.agent), project_dir=str(self.project), trusted_project=True)

    def test_user_layer_loads_without_warning(self):
        for v in (True, False):
            res = self.load(user={"gate": {"readonlyClear": v}})
            self.assertEqual(res["errors"], [])
            self.assertNotIn("readonlyClear", "\n".join(res["warnings"]))
            self.assertIs(res["config"]["gate"]["readonlyClear"], v)

    def test_project_layer_loads_without_warning(self):
        for v in (True, False):
            res = self.load(proj={"gate": {"readonlyClear": v}})
            self.assertEqual(res["errors"], [])
            self.assertNotIn("readonlyClear", "\n".join(res["warnings"]))


if __name__ == "__main__":
    unittest.main()
