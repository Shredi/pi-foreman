"""The key tools.prReadyLabel: empty by default (label handling off), a valid label name by schema, user or overlay config only."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402

SCHEMA = fc.read_json(fc.SCHEMA_PATH)


def issues(name):
    out = []
    fc.validate_schema({"tools": {"prReadyLabel": name}}, SCHEMA, "", out)
    return out


class ReadyLabelKeyTest(unittest.TestCase):
    def test_default_is_empty(self):
        defaults = json.loads((ROOT / "config" / "foreman.defaults.json").read_text("utf-8"))
        self.assertEqual(defaults["tools"]["prReadyLabel"], "")

    def test_valid_names(self):
        for name in ("", "ready", "ready to look", "a" * 50, "x-y", "über", "a-"):
            self.assertEqual(issues(name), [], name)

    def test_invalid_names(self):
        for name in ("a" * 51, "-ready", "a,b", ",", "a\nb", "a\x00b", "a\x7fb", 7, True, ["ready"]):
            self.assertNotEqual(issues(name), [], repr(name))

    def test_project_layer_cannot_set_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(os.path.realpath(tmp))
            agent, project = root / "agent", root / "proj"
            agent.mkdir()
            (project / ".pi").mkdir(parents=True)
            (project / ".git").mkdir()
            (agent / "foreman.json").write_text(json.dumps({"tools": {"prReadyLabel": "ready"}}))
            (project / ".pi" / "foreman.json").write_text(json.dumps({"tools": {"prReadyLabel": "other"}}))
            res = fc.load_config(agent_dir=str(agent), project_dir=str(project), trusted_project=True)
            self.assertEqual(res["config"]["tools"]["prReadyLabel"], "ready")
            self.assertIn("project tools.prReadyLabel ignored", "\n".join(res["warnings"]))


if __name__ == "__main__":
    unittest.main()
