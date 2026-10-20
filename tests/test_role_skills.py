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
ROLE_SCHEMA = json.loads((ROOT / "config" / "foreman.schema.json").read_text())["properties"]["roles"]["additionalProperties"]


def schema_issues(skills):
    issues = []
    fc.validate_schema({"skills": skills}, ROLE_SCHEMA, "roles.builder", issues)
    return issues


class RoleSkillsSchema(unittest.TestCase):
    def test_accepts_a_list_of_plain_names(self):
        self.assertEqual(schema_issues([]), [])
        self.assertEqual(schema_issues(["my-skill", "a.b", "x_y", "Name 2"]), [])

    def test_rejects_a_non_string_item_and_a_non_list(self):
        self.assertTrue(schema_issues(["ok", 3]))
        self.assertTrue(schema_issues("ok"))

    def test_rejects_paths_and_special_names(self):
        for bad in ["../x", "/abs", "a/b", "a\\b", ".", "..", "a*", "a?", "a[b", "a{b", "c:x", ""]:
            issues = schema_issues([bad])
            self.assertTrue(issues, bad)
            self.assertEqual(issues[0][0], "error", bad)


class RoleSkillsConfig(unittest.TestCase):
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

    def test_every_default_role_has_an_empty_skills_list(self):
        roles = json.loads((ROOT / "config" / "foreman.defaults.json").read_text())["roles"]
        self.assertTrue(roles)
        for role, entry in roles.items():
            self.assertEqual(entry.get("skills"), [], role)

    def test_project_and_session_layers_cannot_set_skills(self):
        res = self.load(proj={"roles": {"builder": {"skills": ["evil"]}}},
                        session={"roles": {"explorer": {"skills": ["evil2"]}}})
        self.assertEqual(res["config"]["roles"]["builder"]["skills"], [])
        self.assertEqual(res["config"]["roles"]["explorer"]["skills"], [])
        self.assertTrue([w for w in res["warnings"] if "roles.builder.skills" in w])

    def test_user_layer_keeps_skills(self):
        res = self.load(l2={"roles": {"builder": {"skills": ["alpha", "beta"]}}})
        self.assertEqual(res["errors"], [])
        self.assertEqual(res["config"]["roles"]["builder"]["skills"], ["alpha", "beta"])

    def test_list_is_replaced_on_merge(self):
        base = {"roles": {"builder": {"skills": ["a", "b"]}}}
        over = {"roles": {"builder": {"skills": ["c"]}}}
        self.assertEqual(fc.deep_merge(base, over)["roles"]["builder"]["skills"], ["c"])


class RoleSkillsGenerated(unittest.TestCase):
    def cfg(self, skills):
        cfg = json.loads((ROOT / "config" / "foreman.defaults.json").read_text())
        cfg["providers"] = PROV
        if skills is not None:
            cfg["roles"]["builder"]["skills"] = skills
        return cfg

    def test_block_has_skills_only_when_non_empty(self):
        out = fc.generate_subagents(self.cfg(["alpha"]))["subagents"]["agentOverrides"]
        self.assertEqual(out["builder"]["skills"], ["alpha"])
        for role, entry in out.items():
            if role != "builder":
                self.assertNotIn("skills", entry, role)

    def test_empty_skills_write_no_key(self):
        out = fc.generate_subagents(self.cfg([]))["subagents"]
        for role, entry in out["agentOverrides"].items():
            self.assertNotIn("skills", entry, role)

    def test_never_writes_inherit_skills_or_system_prompt_mode(self):
        out = fc.generate_subagents(self.cfg(["alpha"]))["subagents"]
        text = json.dumps(out)
        self.assertNotIn("inheritSkills", text)
        self.assertNotIn("systemPromptMode", text)


class BenchNoSkillsLines(unittest.TestCase):
    def test_bench_no_skills_lines_unchanged(self):
        lines = (ROOT / "scripts" / "foreman_review_bench.py").read_text().splitlines()
        self.assertIn('            "--no-skills", "-e", str(ADAPTER)]', lines)
        self.assertIn('        self.log("launch: node <pi cli> -p --mode json --no-session --no-context-files --no-skills -e %s --model <model> "', lines)


if __name__ == "__main__":
    unittest.main()
