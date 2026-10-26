import copy
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402

PROV = {
    "p1": {"roles": {r: {"model": "p1/m-" + r, "thinking": "low"} for r in ["foreman"] + fc.CHILD_ROLES}},
}
DENY_MSG = "roles.%s.mcp: role %s denies mcp__* (denyTools); remove mcp or the deny"


class McpConfigTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.agent = Path(self.tmp.name) / "agent"
        self.agent.mkdir()
        self.project = Path(self.tmp.name) / "proj"
        (self.project / ".pi").mkdir(parents=True)
        self._env = os.environ.get("PI_CODING_AGENT_DIR")
        os.environ["PI_CODING_AGENT_DIR"] = str(self.agent)
        self.addCleanup(self._restore_env)

    def _restore_env(self):
        if self._env is None:
            os.environ.pop("PI_CODING_AGENT_DIR", None)
        else:
            os.environ["PI_CODING_AGENT_DIR"] = self._env

    def load(self, proj=None, session=None, l2=None):
        if l2 is not None:
            (self.agent / "foreman.json").write_text(json.dumps(l2))
        if proj is not None:
            (self.project / ".pi" / "foreman.json").write_text(json.dumps(proj))
        return fc.load_config(agent_dir=str(self.agent), project_dir=str(self.project), trusted_project=True,
                              session_json=json.dumps(session) if session is not None else None)

    def test_user_layer_mcp_emits_no_mcp_entries_and_tool_search_before_codemode(self):
        prov = copy.deepcopy(PROV)
        prov["p1"]["roles"]["builder"]["codemode"] = True  # differs from the role default: per-provider tools written
        res = self.load(l2={"providers": prov, "roles": {"builder": {"mcp": ["fx", "gh/search", "fx"]}}})
        self.assertEqual(res["errors"], [])
        self.assertEqual(res["config"]["roles"]["builder"]["mcp"], ["fx", "gh/search", "fx"])
        out = fc.generate_subagents(res["config"])
        self.assertEqual(out["errors"], [])
        tools = out["subagents"]["agentOverrides"]["builder"]["tools"]
        self.assertEqual(tools[-1], "tool_search")
        self.assertFalse([t for t in tools if t.startswith("mcp:")])
        per_provider = out["subagents"]["agentOverridesByProvider"]["p1"]["builder"]["tools"]
        self.assertFalse([t for t in per_provider if t.startswith("mcp:")])
        self.assertEqual(per_provider[-2:], ["tool_search", "codemode"])
        resolved = fc.resolve_role(res["config"], "builder", "p1")["tools"]
        self.assertFalse([t for t in resolved if t.startswith("mcp:")])
        self.assertEqual(resolved[-2:], ["tool_search", "codemode"])

    def test_role_without_mcp_gets_no_mcp_entries(self):
        res = self.load(l2={"providers": PROV})
        out = fc.generate_subagents(res["config"])
        for role, entry in out["subagents"]["agentOverrides"].items():
            self.assertFalse([t for t in entry["tools"] if t.startswith("mcp:")], role)

    def test_every_child_role_gets_tool_search_once_and_foreman_does_not(self):
        res = self.load(l2={"providers": PROV})
        out = fc.generate_subagents(res["config"])
        for role, entry in out["subagents"]["agentOverrides"].items():
            self.assertEqual(entry["tools"].count("tool_search"), 1, role)
            self.assertFalse(fc.resolve_role(res["config"], role, "p1")["tools"].count("tool_search") != 1, role)
        self.assertNotIn("tool_search", fc.resolve_role(res["config"], "foreman", "p1")["tools"])
        self.assertFalse(hasattr(fc, "with_mcp"))

    def test_stale_block_with_mcp_entries_differs_on_the_keys_the_doctor_compares(self):
        # Mirrors the doctor sync check (extensions/core-adapter/index.ts): it compares the keys
        # agentOverridesByProvider, agentOverrides, forceTopLevelAsync of settings.json against generate-subagents.
        res = self.load(l2={"providers": PROV, "roles": {"builder": {"mcp": ["fx"]}}})
        fresh = fc.generate_subagents(res["config"])["subagents"]
        keys = ["agentOverridesByProvider", "agentOverrides", "forceTopLevelAsync"]
        canon = lambda v: json.dumps(v, sort_keys=True)  # noqa: E731
        self.assertTrue(all(canon(fresh[k]) == canon(copy.deepcopy(fresh)[k]) for k in keys))
        stale = copy.deepcopy(fresh)
        stale["agentOverrides"]["builder"]["tools"].append("mcp:fx")
        self.assertFalse(all(canon(stale[k]) == canon(fresh[k]) for k in keys))
        stale = copy.deepcopy(fresh)
        stale["agentOverrides"]["builder"]["tools"].remove("tool_search")
        stale["agentOverrides"]["builder"]["tools"].append("mcp:fx")
        self.assertFalse(all(canon(stale[k]) == canon(fresh[k]) for k in keys))

    def test_project_and_session_layers_cannot_set_mcp(self):
        res = self.load(proj={"roles": {"builder": {"mcp": ["evil"]}}},
                        session={"roles": {"explorer": {"mcp": ["evil2"]}}})
        roles = res["config"]["roles"]
        self.assertNotIn("mcp", roles["builder"])
        self.assertNotIn("mcp", roles["explorer"])
        joined = "\n".join(res["warnings"])
        self.assertIn("project roles.builder.mcp ignored", joined)
        self.assertIn("session roles.explorer.mcp ignored", joined)

    def test_denied_role_with_mcp_is_a_config_error(self):
        res = self.load(l2={"roles": {"reviewer": {"mcp": ["fx"]}}})
        self.assertIn(DENY_MSG % ("reviewer", "reviewer"), res["errors"])

    def test_user_deny_on_builder_with_mcp_is_a_config_error(self):
        res = self.load(l2={"roles": {"builder": {"mcp": ["fx/echo"], "denyTools": ["mcp__*"]}}})
        self.assertIn(DENY_MSG % ("builder", "builder"), res["errors"])

    def test_deny_for_another_namespace_does_not_block_mcp(self):
        res = self.load(l2={"roles": {"builder": {"mcp": ["fx"], "denyTools": ["mcp__other__*"]}}})
        self.assertEqual([e for e in res["errors"] if ".mcp" in e], [])

    def test_non_child_roles_with_mcp_are_a_config_error(self):
        res = self.load(l2={"roles": {"foreman": {"mcp": ["fx"]}, "session-foreman": {"mcp": ["fx"]}}})
        for rid in ("foreman", "session-foreman"):
            self.assertIn("roles.%s.mcp: only child roles take mcp; the main session already loads every enabled "
                          "server in mcp.json" % rid, res["errors"])

    def test_deny_glob_matches_the_name_pi_gives_a_tool_with_odd_characters(self):
        res = self.load(l2={"roles": {"builder": {"mcp": ["fx/a.b"], "denyTools": ["mcp__fx__a_b"]}}})
        self.assertIn(DENY_MSG.replace("mcp__*", "mcp__fx__a_b") % ("builder", "builder"), res["errors"])

    def test_builder_with_mcp_is_accepted(self):
        res = self.load(l2={"roles": {"builder": {"mcp": ["fx"]}}})
        self.assertEqual([e for e in res["errors"] if ".mcp" in e], [])

    def test_schema_rejects_non_string_entries_and_non_array(self):
        schema = fc.read_json(fc.SCHEMA_PATH)
        issues = []
        fc.validate_schema({"roles": {"builder": {"mcp": [1]}}}, schema, "", issues)
        fc.validate_schema({"roles": {"builder": {"mcp": "fx"}}}, schema, "", issues)
        messages = [m for kind, _p, m in issues if kind == "error"]
        self.assertIn("roles.builder.mcp[0]: expected string", messages)
        self.assertIn("roles.builder.mcp: expected array", messages)


if __name__ == "__main__":
    unittest.main()
