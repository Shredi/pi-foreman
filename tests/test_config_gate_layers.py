"""gate.* keys, the review model, permissions.profile and safety.preBash are tighten-only (or user-layer only) for
the project and session layers (plan Addendum B, Addendum 5). r79 items 8, 9: gate.policy.userFile and safety.policy.files
are gone (permissions.json holds the rules); permissions.profile is a user, organisation and default layer key."""
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

    def test_log_size_is_user_layer_only(self):
        res = self.load(l2={"gate": {"logMaxBytes": 4096}}, proj={"gate": {"logMaxBytes": 2048}})
        self.assertEqual(res["config"]["gate"]["logMaxBytes"], 4096)
        self.warned(res, "project gate.logMaxBytes ignored")
        self.assertEqual(res["errors"], [])

    def test_removed_policy_keys_are_unknown_keys_now(self):
        # r79 item 9: a leftover gate.policy.userFile or safety.policy.files is reported as an unknown key (doctor FAILs on it)
        for section, l2 in ("gate", {"gate": {"policy": {"userFile": "mine.md"}}}), ("safety", {"safety": {"policy": {"files": ["a.md"]}}}):
            res = self.load(l2=l2)
            self.warned(res, "unknown key %s.policy" % section)

    def test_permissions_profile_is_honoured_in_the_user_layer_only(self):
        res = self.load(l2={"permissions": {"profile": "steward"}}, proj={"permissions": {"profile": "mine"}})
        self.assertEqual(res["config"]["permissions"]["profile"], "steward")
        self.warned(res, "project permissions.profile ignored")
        self.assertEqual(res["errors"], [])
        self.assertNotIn("unknown key permissions", "\n".join(res["warnings"]))
        res = self.load(l2={"permissions": {"profile": "steward"}}, session={"permissions": {"profile": "mine"}})
        self.assertEqual(res["config"]["permissions"]["profile"], "steward")
        self.warned(res, "session permissions.profile ignored")

    def test_permissions_profile_alone_in_a_project_leaves_none(self):
        res = self.load(proj={"permissions": {"profile": "steward"}})
        self.assertIsNone((res["config"].get("permissions") or {}).get("profile"))
        self.warned(res, "project permissions.profile ignored")

    def test_unknown_project_gate_key_ignored_with_a_warning(self):
        res = self.load(proj={"gate": {"mode": "off"}})
        self.assertNotIn("mode", res["config"]["gate"])
        self.warned(res, "project gate.mode ignored")
        self.assertEqual(res["errors"], [])

    def test_session_layer_follows_the_same_rules(self):
        res = self.load(l2={"gate": {"childAsk": "deny", "tmpAccess": False}},
                        session={"gate": {"childAsk": "parent", "tmpAccess": True, "logMaxBytes": 2048}})
        self.assertEqual(res["config"]["gate"]["childAsk"], "deny")
        self.assertIs(res["config"]["gate"]["tmpAccess"], False)
        self.assertEqual(res["config"]["gate"]["logMaxBytes"], 20971520)

    def test_review_model_is_user_layer_only(self):
        l2 = {"providers": {"p": {"roles": {"review": {"model": "good-model"}}}}}
        proj = {"providers": {"p": {"roles": {"review": {"model": "weak-model"}}, "review": {"model": "weak-model"}}},
                "roles": {"review": {"model": "weak-model"}}}
        res = self.load(l2=l2, proj=proj)
        self.assertEqual(res["config"]["providers"]["p"]["roles"]["review"]["model"], "good-model")
        self.assertNotIn("review", res["config"]["providers"]["p"])
        self.assertNotIn("review", res["config"].get("roles", {}))
        self.warned(res, "project providers.p.roles.review ignored")

    def test_pre_bash_is_user_layer_only(self):
        l2 = {"safety": {"preBash": {"hooks": ["h.mjs"], "strict": True}}}
        proj = {"safety": {"preBash": {"hooks": [], "strict": False}}}
        res = self.load(l2=l2, proj=proj)
        safety = res["config"]["safety"]
        self.assertEqual(safety["preBash"], {"hooks": ["h.mjs"], "strict": True})
        self.warned(res, "project safety.preBash.strict ignored")

    def test_project_cannot_remove_user_deny_entries(self):
        l2 = {"safety": {"git": {"protectedBranches": ["main", "release"]}, "requiredChildExtensions": ["ext-a"]}}
        proj = {"safety": {"git": {"protectedBranches": ["dev"]}, "requiredChildExtensions": []}}
        res = self.load(l2=l2, proj=proj)
        self.assertEqual(res["config"]["safety"]["git"]["protectedBranches"], ["main", "release", "dev"])
        self.assertEqual(res["config"]["safety"]["requiredChildExtensions"], ["ext-a"])


if __name__ == "__main__":
    unittest.main()
