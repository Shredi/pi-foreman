"""gate.log.fullCommand and gate.unclassified are user or overlay keys: not in GATE_LAYER_KEYS, so a project or session layer cannot set them
(plan gate-verify D6); the defaults are false and allow."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402


class GateJudgeKeysTest(unittest.TestCase):
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

    def test_defaults(self):
        gate = self.load()["config"]["gate"]
        self.assertIs(gate["log"]["fullCommand"], False)
        self.assertEqual(gate["unclassified"], "allow")

    def test_user_layer_sets_both(self):
        res = self.load(l2={"gate": {"log": {"fullCommand": True}, "unclassified": "judge"}})
        self.assertIs(res["config"]["gate"]["log"]["fullCommand"], True)
        self.assertEqual(res["config"]["gate"]["unclassified"], "judge")
        self.assertEqual(res["errors"], [])

    def test_project_file_cannot_set_either(self):
        res = self.load(proj={"gate": {"log": {"fullCommand": True}, "unclassified": "judge"}})
        self.assertIs(res["config"]["gate"]["log"]["fullCommand"], False)
        self.assertEqual(res["config"]["gate"]["unclassified"], "allow")
        text = "\n".join(res["warnings"])
        self.assertIn("project gate.log ignored", text)
        self.assertIn("project gate.unclassified ignored", text)
        self.assertEqual(res["errors"], [])

    def test_project_file_cannot_override_the_user_value(self):
        res = self.load(l2={"gate": {"unclassified": "judge"}}, proj={"gate": {"unclassified": "allow"}})
        self.assertEqual(res["config"]["gate"]["unclassified"], "judge")

    def test_session_layer_cannot_set_either(self):
        res = self.load(session={"gate": {"log": {"fullCommand": True}, "unclassified": "judge"}})
        self.assertIs(res["config"]["gate"]["log"]["fullCommand"], False)
        self.assertEqual(res["config"]["gate"]["unclassified"], "allow")
        self.assertIn("session gate.unclassified ignored", "\n".join(res["warnings"]))


if __name__ == "__main__":
    unittest.main()
