"""The key tools.prPhases: empty by default, a schema-checked list of rules, user or overlay config only (a project value is ignored)."""
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
EXAMPLE = [{"repos": ["acme/*"], "gate": ["ci/gate"], "ignore": ["review-assign"], "mergeLabel": "merge"}]


def issues(value):
    out = []
    fc.validate_schema({"tools": {"prPhases": value}}, SCHEMA, "", out)
    return out


class PrPhasesKeyTest(unittest.TestCase):
    def test_default_is_empty(self):
        defaults = json.loads((ROOT / "config" / "foreman.defaults.json").read_text("utf-8"))
        self.assertEqual(defaults["tools"]["prPhases"], [])

    def test_schema_accepts_the_example(self):
        self.assertEqual(issues(EXAMPLE), [])
        self.assertEqual(issues([]), [])

    def test_schema_rejects_a_bad_merge_label(self):
        for label in ("-merge", "a,b", "a" * 51, 7):
            self.assertNotEqual(issues([dict(EXAMPLE[0], mergeLabel=label)]), [], repr(label))

    def test_project_layer_is_ignored_user_and_overlay_kept(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(os.path.realpath(tmp))
            agent, project = root / "agent", root / "proj"
            agent.mkdir()
            (project / ".pi").mkdir(parents=True)
            (project / ".git").mkdir()
            (agent / "foreman.json").write_text(json.dumps({"tools": {"prPhases": EXAMPLE}}))
            (project / ".pi" / "foreman.json").write_text(json.dumps({"tools": {"prPhases": [{"gate": ["other"]}]}}))
            res = fc.load_config(agent_dir=str(agent), project_dir=str(project), trusted_project=True)
            self.assertEqual(res["config"]["tools"]["prPhases"], EXAMPLE)
            self.assertIn("project tools.prPhases ignored", "\n".join(res["warnings"]))

    def test_overlay_layer_is_kept(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(os.path.realpath(tmp))
            agent = root / "agent"
            agent.mkdir()
            overlay = root / "overlay.json"
            overlay.write_text(json.dumps({"tools": {"prPhases": EXAMPLE}}))
            res = fc.load_config(agent_dir=str(agent), l3_paths=[str(overlay)])
            self.assertEqual(res["config"]["tools"]["prPhases"], EXAMPLE)


if __name__ == "__main__":
    unittest.main()
