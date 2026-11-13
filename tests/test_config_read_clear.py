"""gate.readClear (the read question): default true; the project and session layers may only set false."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402


class ReadClearLayerTest(unittest.TestCase):
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

    def test_default_is_true(self):
        self.assertIs(self.load()["config"]["gate"]["readClear"], True)

    def test_user_layer_may_set_either_value(self):
        self.assertIs(self.load(l2={"gate": {"readClear": False}})["config"]["gate"]["readClear"], False)
        self.assertIs(self.load(l2={"gate": {"readClear": True}})["config"]["gate"]["readClear"], True)

    def test_project_may_set_false_only(self):
        self.assertIs(self.load(proj={"gate": {"readClear": False}})["config"]["gate"]["readClear"], False)
        res = self.load(l2={"gate": {"readClear": False}}, proj={"gate": {"readClear": True}})
        self.assertIs(res["config"]["gate"]["readClear"], False)
        self.assertIn("project gate.readClear ignored", "\n".join(res["warnings"]))

    def test_session_may_set_false_only(self):
        self.assertIs(self.load(session={"gate": {"readClear": False}})["config"]["gate"]["readClear"], False)
        res = self.load(l2={"gate": {"readClear": False}}, session={"gate": {"readClear": True}})
        self.assertIs(res["config"]["gate"]["readClear"], False)

    def test_user_layer_overrides_an_organisation_overlay(self):
        # the overlay (L3) merges below the user layer (L2): the user's true wins over the organisation's false, no warning
        overlay = self.agent.parent / "org.json"
        overlay.write_text(json.dumps({"gate": {"readClear": False}}))
        (self.agent / "foreman.json").write_text(json.dumps({"gate": {"readClear": True}}))
        res = fc.load_config(agent_dir=str(self.agent), project_dir=str(self.project), trusted_project=True, l3_paths=[str(overlay)])
        self.assertIs(res["config"]["gate"]["readClear"], True)
        self.assertEqual(res["warnings"], [])
        overlay_only = fc.load_config(agent_dir=str(self.agent.parent / "none"), project_dir=str(self.project), trusted_project=True, l3_paths=[str(overlay)])
        self.assertIs(overlay_only["config"]["gate"]["readClear"], False)

    def test_non_boolean_in_the_user_layer_is_an_error_and_is_kept(self):
        res = self.load(l2={"gate": {"readClear": "false"}})
        self.assertIn("gate.readClear: expected boolean", res["errors"])
        self.assertEqual(res["config"]["gate"]["readClear"], "false")

    def test_non_boolean_is_not_taken(self):
        res = self.load(proj={"gate": {"readClear": "no"}})
        self.assertIs(res["config"]["gate"]["readClear"], True)


if __name__ == "__main__":
    unittest.main()
