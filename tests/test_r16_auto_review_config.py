"""R16 item 1/2: safety.permissions.autoReview {enabled, rulesFile} is set by L1/L3/L2 only (ruling D3: rulesFile from the user layer)."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402


class AutoReviewConfigTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.agent = Path(self.tmp.name) / "agent"
        self.agent.mkdir()
        self.project = Path(self.tmp.name) / "proj"
        (self.project / ".pi").mkdir(parents=True)

    def load(self, l2=None, proj=None, session=None):
        if l2 is not None:
            (self.agent / "foreman.json").write_text(json.dumps(l2))
        if proj is not None:
            (self.project / ".pi" / "foreman.json").write_text(json.dumps(proj))
        res = fc.load_config(agent_dir=str(self.agent), project_dir=str(self.project), trusted_project=True,
                             session_json=json.dumps(session) if session is not None else None, l3_paths=[])
        return res["config"]["safety"]["permissions"]["autoReview"], res

    def test_default_on_with_the_shipped_rules(self):
        self.assertEqual(self.load()[0], {"enabled": True, "rulesFile": None})

    def test_user_layer_sets_rules_file_and_switch(self):
        val, res = self.load(l2={"safety": {"permissions": {"autoReview": {"enabled": False, "rulesFile": "~/my-rules.md"}}}})
        self.assertEqual(val, {"enabled": False, "rulesFile": "~/my-rules.md"})
        self.assertEqual(res["basePermissions"]["autoReview"]["rulesFile"], "~/my-rules.md")

    def test_project_and_session_cannot_set_it(self):
        bad = {"safety": {"permissions": {"autoReview": {"enabled": False, "rulesFile": "/tmp/evil.md"}}}}
        for kw in ({"proj": bad}, {"session": bad}):
            val, res = self.load(**kw)
            self.assertEqual(val, {"enabled": True, "rulesFile": None}, kw)
            self.assertTrue(any("autoReview" in w for w in res["warnings"]), res["warnings"])

    def test_unknown_key_is_a_schema_error(self):
        _, res = self.load(l2={"safety": {"permissions": {"autoReview": {"surfaces": ["bash"]}}}})
        self.assertTrue(any("surfaces" in m for m in res["warnings"] + res["errors"]), (res["warnings"], res["errors"]))


if __name__ == "__main__":
    unittest.main()
