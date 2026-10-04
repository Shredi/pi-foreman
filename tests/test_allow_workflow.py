"""safety.subagents.allowWorkflow is a loosening key: L1/L3/L2 only (plan D6, review D6)."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402


class AllowWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.agent = Path(self.tmp.name) / "agent"
        self.agent.mkdir()
        self.project = Path(self.tmp.name) / "proj"
        (self.project / ".pi").mkdir(parents=True)

    def load(self, l2=None, proj=None, session=None, l3=None):
        if l2 is not None:
            (self.agent / "foreman.json").write_text(json.dumps(l2))
        if proj is not None:
            (self.project / ".pi" / "foreman.json").write_text(json.dumps(proj))
        l3_paths = []
        if l3 is not None:
            p = Path(self.tmp.name) / "l3.json"
            p.write_text(json.dumps(l3))
            l3_paths.append(str(p))
        res = fc.load_config(agent_dir=str(self.agent), project_dir=str(self.project), trusted_project=True,
                             session_json=json.dumps(session) if session is not None else None, l3_paths=l3_paths)
        return res["config"]["safety"]["subagents"]["allowWorkflow"], res["warnings"]

    def test_default_false_and_user_or_overlay_can_set_it(self):
        self.assertEqual(self.load()[0], False)
        self.assertEqual(self.load(l2={"safety": {"subagents": {"allowWorkflow": True}}})[0], True)
        self.assertEqual(self.load(l3={"safety": {"subagents": {"allowWorkflow": True}}})[0], True)

    def test_project_value_ignored_with_warning(self):
        val, warnings = self.load(proj={"safety": {"subagents": {"allowWorkflow": True}}})
        self.assertEqual(val, False)
        self.assertTrue(any("safety.subagents.allowWorkflow ignored" in w for w in warnings), warnings)

    def test_session_value_dropped_with_warning(self):
        val, warnings = self.load(session={"safety": {"subagents": {"allowWorkflow": True}}})
        self.assertEqual(val, False)
        self.assertTrue(any(w.startswith("session safety.subagents.allowWorkflow ignored") for w in warnings), warnings)
        # A session cannot switch an L2 true off either: the key is not a session key at all.
        val, _ = self.load(l2={"safety": {"subagents": {"allowWorkflow": True}}},
                           session={"safety": {"subagents": {"allowWorkflow": False}}})
        self.assertEqual(val, True)


if __name__ == "__main__":
    unittest.main()
