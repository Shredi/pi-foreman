"""ladder.equalOnStrongRisk: user or overlay config may set true; a project or session can only set false."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402


class EqualOnStrongRiskTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(os.path.realpath(self.tmp.name))
        self.agent = root / "agent"
        self.agent.mkdir()
        self.project = root / "proj"
        (self.project / ".pi").mkdir(parents=True)
        (self.project / ".git").mkdir()

    def load(self, l2=None, proj=None, session=None):
        if l2 is not None:
            (self.agent / "foreman.json").write_text(json.dumps(l2))
        if proj is not None:
            (self.project / ".pi" / "foreman.json").write_text(json.dumps(proj))
        return fc.load_config(agent_dir=str(self.agent), project_dir=str(self.project), trusted_project=True,
                              l3_paths=[], session_json=json.dumps(session) if session is not None else None)

    def test_user_true_is_kept(self):
        res = self.load(l2={"ladder": {"equalOnStrongRisk": True}})
        self.assertEqual(res["errors"], [])
        self.assertIs(res["config"]["ladder"]["equalOnStrongRisk"], True)

    def test_project_true_is_dropped_with_a_warning(self):
        res = self.load(l2={}, proj={"ladder": {"equalOnStrongRisk": True}})
        self.assertNotIn("equalOnStrongRisk", res["config"]["ladder"])
        self.assertIn("project ladder.equalOnStrongRisk ignored", "\n".join(res["warnings"]))

    def test_session_true_is_dropped_with_a_warning(self):
        res = self.load(l2={}, proj={}, session={"ladder": {"equalOnStrongRisk": True}})
        self.assertNotIn("equalOnStrongRisk", res["config"]["ladder"])
        self.assertIn("session ladder.equalOnStrongRisk ignored", "\n".join(res["warnings"]))

    def test_project_false_wins_over_user_true(self):
        res = self.load(l2={"ladder": {"equalOnStrongRisk": True}}, proj={"ladder": {"equalOnStrongRisk": False}})
        self.assertIs(res["config"]["ladder"]["equalOnStrongRisk"], False)

    def test_absent_is_not_set(self):
        res = self.load(l2={}, proj={})
        self.assertNotIn("equalOnStrongRisk", res["config"]["ladder"])

    def test_the_schema_rejects_a_non_boolean(self):
        res = self.load(l2={"ladder": {"equalOnStrongRisk": "yes"}})
        self.assertTrue(any("equalOnStrongRisk" in m for m in res["errors"] + res["warnings"]), res)


if __name__ == "__main__":
    unittest.main()
