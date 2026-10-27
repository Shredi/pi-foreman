"""gate.* keys, the review model, safety.policy.files and safety.preBash are tighten-only (or user-layer only) for
the project and session layers (plan Addendum B, Addendum 5)."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402


class GateLayerTest(unittest.TestCase):
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

    def warned(self, res, text):
        self.assertIn(text, "\n".join(res["warnings"]))

    def test_tmp_access_project_cannot_set_true_over_user_false(self):
        res = self.load(l2={"gate": {"tmpAccess": False}}, proj={"gate": {"tmpAccess": True}})
        self.assertIs(res["config"]["gate"]["tmpAccess"], False)
        self.warned(res, "project gate.tmpAccess ignored")
        self.assertEqual(res["errors"], [])

    def test_tmp_access_project_may_set_false(self):
        res = self.load(proj={"gate": {"tmpAccess": False}})
        self.assertIs(res["config"]["gate"]["tmpAccess"], False)

    def test_timeouts_project_may_only_lower(self):
        res = self.load(l2={"gate": {"askTimeoutMs": 60000, "reviewTimeoutMs": 5000}},
                        proj={"gate": {"askTimeoutMs": 120000, "reviewTimeoutMs": 9000}})
        self.assertEqual(res["config"]["gate"]["askTimeoutMs"], 60000)
        self.assertEqual(res["config"]["gate"]["reviewTimeoutMs"], 5000)
        self.warned(res, "project gate.askTimeoutMs ignored")
        self.warned(res, "project gate.reviewTimeoutMs ignored")
        res = self.load(l2={"gate": {"askTimeoutMs": 60000, "reviewTimeoutMs": 5000}},
                        proj={"gate": {"askTimeoutMs": 30000, "reviewTimeoutMs": 2000}})
        self.assertEqual(res["config"]["gate"]["askTimeoutMs"], 30000)
        self.assertEqual(res["config"]["gate"]["reviewTimeoutMs"], 2000)

    def test_review_timeout_below_schema_minimum_is_dropped(self):
        res = self.load(proj={"gate": {"reviewTimeoutMs": 10}})
        self.assertEqual(res["config"]["gate"]["reviewTimeoutMs"], 15000)
        self.assertEqual(res["errors"], [])

    def test_child_ask_project_cannot_loosen_deny_to_parent(self):
        res = self.load(l2={"gate": {"childAsk": "deny"}}, proj={"gate": {"childAsk": "parent"}})
        self.assertEqual(res["config"]["gate"]["childAsk"], "deny")
        self.warned(res, "project gate.childAsk ignored")

    def test_child_ask_project_may_set_deny(self):
        res = self.load(proj={"gate": {"childAsk": "deny"}})
        self.assertEqual(res["config"]["gate"]["childAsk"], "deny")

    def test_child_ask_invalid_value_ignored(self):
        res = self.load(proj={"gate": {"childAsk": "anyone"}})
        self.assertEqual(res["config"]["gate"]["childAsk"], "parent")
        self.assertEqual(res["errors"], [])

    def test_policy_user_file_and_log_size_are_user_layer_only(self):
        res = self.load(l2={"gate": {"policy": {"userFile": "mine.md"}}},
                        proj={"gate": {"policy": {"userFile": "/tmp/evil.md"}, "logMaxBytes": 2048}})
        self.assertEqual(res["config"]["gate"]["policy"]["userFile"], "mine.md")
        self.assertEqual(res["config"]["gate"]["logMaxBytes"], 20971520)
        self.warned(res, "project gate.policy ignored")
        self.warned(res, "project gate.logMaxBytes ignored")
        self.assertEqual(res["errors"], [])

    def test_unknown_project_gate_key_ignored_with_a_warning(self):
        res = self.load(proj={"gate": {"mode": "off"}})
        self.assertNotIn("mode", res["config"]["gate"])
        self.warned(res, "project gate.mode ignored")
        self.assertEqual(res["errors"], [])

    def test_session_layer_follows_the_same_rules(self):
        res = self.load(l2={"gate": {"childAsk": "deny", "tmpAccess": False}},
                        session={"gate": {"childAsk": "parent", "tmpAccess": True, "policy": {"userFile": "x"}}})
        self.assertEqual(res["config"]["gate"]["childAsk"], "deny")
        self.assertIs(res["config"]["gate"]["tmpAccess"], False)
        self.assertIsNone(res["config"]["gate"].get("policy", {}).get("userFile"))

    def test_review_model_is_user_layer_only(self):
        l2 = {"providers": {"p": {"roles": {"review": {"model": "good-model"}}}}}
        proj = {"providers": {"p": {"roles": {"review": {"model": "weak-model"}}, "review": {"model": "weak-model"}}},
                "roles": {"review": {"model": "weak-model"}}}
        res = self.load(l2=l2, proj=proj)
        self.assertEqual(res["config"]["providers"]["p"]["roles"]["review"]["model"], "good-model")
        self.assertNotIn("review", res["config"]["providers"]["p"])
        self.assertNotIn("review", res["config"].get("roles", {}))
        self.warned(res, "project providers.p.roles.review ignored")

    def test_policy_files_and_pre_bash_are_user_layer_only(self):
        l2 = {"safety": {"policy": {"files": ["a.md"]}, "preBash": {"hooks": ["h.mjs"], "strict": True}}}
        proj = {"safety": {"policy": {"files": []}, "preBash": {"hooks": [], "strict": False}}}
        res = self.load(l2=l2, proj=proj)
        safety = res["config"]["safety"]
        self.assertEqual(safety["policy"]["files"], ["a.md"])
        self.assertEqual(safety["preBash"], {"hooks": ["h.mjs"], "strict": True})
        self.warned(res, "project safety.policy.files ignored")
        self.warned(res, "project safety.preBash.strict ignored")

    def test_project_cannot_remove_user_deny_entries(self):
        l2 = {"safety": {"git": {"protectedBranches": ["main", "release"]}, "requiredChildExtensions": ["ext-a"]}}
        proj = {"safety": {"git": {"protectedBranches": ["dev"]}, "requiredChildExtensions": []}}
        res = self.load(l2=l2, proj=proj)
        self.assertEqual(res["config"]["safety"]["git"]["protectedBranches"], ["main", "release", "dev"])
        self.assertEqual(res["config"]["safety"]["requiredChildExtensions"], ["ext-a"])


if __name__ == "__main__":
    unittest.main()
