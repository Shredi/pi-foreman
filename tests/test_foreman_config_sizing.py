import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402

SIZING = {"enabled": False, "largeFileLines": 5, "maxModules": 9, "strongRisks": [], "topRisks": [], "topRung": "x/y"}


class SizingLayerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.agent = Path(self.tmp.name) / "agent"
        self.agent.mkdir()
        self.project = Path(self.tmp.name) / "proj"
        (self.project / ".pi").mkdir(parents=True)
        self._env = os.environ.get("PI_CODING_AGENT_DIR")
        os.environ["PI_CODING_AGENT_DIR"] = str(self.agent)
        self.addCleanup(self._restore_env)

    def _restore_env(self):
        if self._env is None:
            os.environ.pop("PI_CODING_AGENT_DIR", None)
        else:
            os.environ["PI_CODING_AGENT_DIR"] = self._env

    def test_project_and_session_layers_cannot_set_sizing(self):
        (self.agent / "foreman.json").write_text("{}")
        (self.project / ".pi" / "foreman.json").write_text(json.dumps({"ladder": {"sizing": SIZING}}))
        res = fc.load_config(project_dir=str(self.project), trusted_project=True, session_json=json.dumps({"ladder": {"sizing": {"enabled": False}}}))
        sizing = res["config"].get("ladder", {}).get("sizing")
        self.assertTrue(sizing is None or sizing.get("enabled") is not False)
        self.assertNotEqual((sizing or {}).get("largeFileLines"), 5)
        text = "\n".join(res["warnings"])
        self.assertIn("project ladder.sizing ignored", text)
        self.assertIn("session ladder.sizing ignored", text)


if __name__ == "__main__":
    unittest.main()
