"""The key radar.openPrs.hideRepos: empty by default, glob strings by schema, user or overlay config only."""
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


def issues(value):
    out = []
    fc.validate_schema({"radar": {"openPrs": {"hideRepos": value}}}, SCHEMA, "", out)
    return out


class HideReposKeyTest(unittest.TestCase):
    def test_default_is_empty(self):
        defaults = json.loads((ROOT / "config" / "foreman.defaults.json").read_text("utf-8"))
        self.assertEqual(defaults["radar"]["openPrs"]["hideRepos"], [])

    def test_valid_values(self):
        for v in ([], ["acme/archive"], ["acme/*", "Acme/old-?"], ["x" * 200]):
            self.assertEqual(issues(v), [], v)

    def test_invalid_values(self):
        for v in ("acme/*", [1], [""], ["  "], ["a\x01b"], ["a\x7fb"], ["x" * 201], {"a": 1}):
            self.assertNotEqual(issues(v), [], repr(v))

    def test_project_layer_cannot_set_it_and_user_layer_can(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(os.path.realpath(tmp))
            agent, project = root / "agent", root / "proj"
            agent.mkdir()
            (project / ".pi").mkdir(parents=True)
            (project / ".git").mkdir()
            (agent / "foreman.json").write_text(json.dumps({"radar": {"openPrs": {"hideRepos": ["acme/a"]}}}))
            (project / ".pi" / "foreman.json").write_text(json.dumps({"radar": {"openPrs": {"hideRepos": ["acme/b"]}}}))
            res = fc.load_config(agent_dir=str(agent), project_dir=str(project), trusted_project=True)
            self.assertEqual(res["config"]["radar"]["openPrs"]["hideRepos"], ["acme/a"])
            self.assertIn("project radar.openPrs ignored", "\n".join(res["warnings"]))


if __name__ == "__main__":
    unittest.main()
