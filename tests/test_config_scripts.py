"""safety.scripts.silentFixLines: default 5; a project layer may lower it, never raise it."""
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import foreman_config as fc  # noqa: E402


class ScriptsConfigTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="pf-scripts-cfg-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.agent = os.path.join(self.tmp, "agent")
        self.proj = os.path.join(self.tmp, "proj")
        os.makedirs(self.agent)
        os.makedirs(os.path.join(self.proj, ".pi"))

    def load(self, project=None, user=None):
        if user is not None:
            Path(self.agent, "foreman.json").write_text(json.dumps({"safety": {"scripts": user}}), "utf-8")
        if project is not None:
            Path(self.proj, ".pi", "foreman.json").write_text(json.dumps({"safety": {"scripts": project}}), "utf-8")
        res = fc.load_config(agent_dir=self.agent, project_dir=self.proj, trusted_project=True)
        return res["config"]["safety"]["scripts"]["silentFixLines"], "\n".join(res["warnings"])

    def test_default_is_five(self):
        value, warn = self.load()
        self.assertEqual(value, 5)
        self.assertNotIn("silentFixLines", warn)

    def test_project_layer_lowers(self):
        value, warn = self.load(project={"silentFixLines": 2})
        self.assertEqual(value, 2)
        self.assertNotIn("silentFixLines", warn)
        value, _ = self.load(project={"silentFixLines": 0})
        self.assertEqual(value, 0, "0 turns silent fixes off")

    def test_project_layer_does_not_raise(self):
        value, warn = self.load(project={"silentFixLines": 50})
        self.assertEqual(value, 5)
        self.assertIn("safety.scripts.silentFixLines ignored: it would loosen the policy", warn)

    def test_project_layer_does_not_raise_above_a_lowered_user_value(self):
        value, warn = self.load(user={"silentFixLines": 1}, project={"silentFixLines": 4})
        self.assertEqual(value, 1)
        self.assertIn("safety.scripts.silentFixLines", warn)

    def test_project_layer_rejects_a_non_integer(self):
        for bad in (-1, True, "3", 2.5):
            value, warn = self.load(project={"silentFixLines": bad})
            self.assertEqual(value, 5, bad)
            self.assertIn("safety.scripts.silentFixLines", warn)


if __name__ == "__main__":
    unittest.main()
