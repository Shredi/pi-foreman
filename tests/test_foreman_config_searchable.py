"""roles.<id>.searchable and skill visibility (token diet): allowlist, layer rules, agent-file skill filter."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402

PROV = {"p1": {"roles": {r: {"model": "p1/m-" + r, "thinking": "low"} for r in ["foreman"] + fc.CHILD_ROLES}}}


class SearchableTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.agent = Path(self.tmp.name) / "agent"
        self.agent.mkdir()
        self.project = Path(self.tmp.name) / "proj"
        (self.project / ".pi").mkdir(parents=True)
        saved = os.environ.get("PI_CODING_AGENT_DIR")
        os.environ["PI_CODING_AGENT_DIR"] = str(self.agent)
        self.addCleanup(lambda: os.environ.pop("PI_CODING_AGENT_DIR", None) if saved is None else os.environ.__setitem__("PI_CODING_AGENT_DIR", saved))

    def load(self, user=None, project=None, session=None):
        (self.agent / "foreman.json").write_text(json.dumps({"providers": PROV, **(user or {})}))
        if project is not None:
            (self.project / ".pi" / "foreman.json").write_text(json.dumps(project))
        return fc.load_config(project_dir=str(self.project), trusted_project=True, session_json=json.dumps(session) if session else None)

    def skill(self, root, name, extra=""):
        d = Path(root) / name
        d.mkdir(parents=True)
        (d / "SKILL.md").write_text("---\nname: %s\ndescription: An example skill.\n%s---\n\nBody\n" % (name, extra))
        return d / "SKILL.md"

    # ---- allowlist

    def test_builder_default_moves_the_move_and_copy_tools_to_searchable(self):
        cfg = self.load()["config"]
        self.assertEqual(cfg["roles"]["builder"]["searchable"], ["foreman_move", "foreman_copy"])
        self.assertNotIn("foreman_move", cfg["roles"]["builder"]["tools"])
        self.assertNotIn("searchable", cfg["roles"]["reviewer"])

    def test_allowlist_is_tools_plus_searchable(self):
        cfg = self.load()["config"]
        tools = fc.generate_subagents(cfg)["subagents"]["agentOverrides"]["builder"]["tools"]
        self.assertEqual(tools[:7], ["read", "ls", "grep", "find", "bash", "edit", "write"])
        self.assertIn("foreman_move", tools)
        self.assertIn("foreman_copy", tools)
        self.assertIn("foreman_move", fc.resolve_role(cfg, "builder", "p1")["tools"])

    def test_searchable_goes_through_the_denied_tool_filter(self):
        cfg = self.load(user={"roles": {"explorer": {"searchable": ["example_tool", "intercom", "pr_create"]}}})["config"]
        tools = fc.generate_subagents(cfg)["subagents"]["agentOverrides"]["explorer"]["tools"]
        self.assertIn("example_tool", tools)
        self.assertNotIn("intercom", tools)
        self.assertNotIn("pr_create", tools)
        self.assertNotIn("intercom", fc.resolve_role(cfg, "explorer", "p1")["tools"])

    def test_a_name_in_both_lists_appears_once(self):
        cfg = self.load(user={"roles": {"explorer": {"searchable": ["read", "example_tool"]}}})["config"]
        tools = fc.generate_subagents(cfg)["subagents"]["agentOverrides"]["explorer"]["tools"]
        self.assertEqual(tools.count("read"), 1)

    # ---- layers

    def test_project_can_narrow_searchable_not_widen(self):
        res = self.load(project={"roles": {"builder": {"searchable": ["foreman_copy", "example_tool"]}}})
        self.assertEqual(res["config"]["roles"]["builder"]["searchable"], ["foreman_copy"])
        self.assertTrue(any("roles.builder.searchable" in w and "example_tool" in w for w in res["warnings"]))

    def test_session_can_narrow_searchable_not_widen(self):
        res = self.load(session={"roles": {"builder": {"searchable": ["foreman_move", "example_tool"]}}})
        self.assertEqual(res["config"]["roles"]["builder"]["searchable"], ["foreman_move"])

    def test_project_cannot_add_searchable_to_a_role_without_it(self):
        res = self.load(project={"roles": {"reviewer": {"searchable": ["example_tool"]}}})
        self.assertNotIn("searchable", res["config"]["roles"]["reviewer"])

    def test_project_cannot_move_a_tool_into_searchable_from_tools(self):
        res = self.load(project={"roles": {"builder": {"searchable": ["bash"]}}})
        self.assertEqual(res["config"]["roles"]["builder"]["searchable"], [])

    def test_a_tool_dropped_from_tools_cannot_return_through_searchable(self):
        user = {"roles": {"builder": {"tools": ["read", "bash", "example_tool"], "searchable": ["example_tool", "foreman_copy"]}}}
        res = self.load(user=user, project={"roles": {"builder": {"tools": ["read", "bash"]}}})
        self.assertEqual(res["config"]["roles"]["builder"]["tools"], ["read", "bash"])
        self.assertEqual(res["config"]["roles"]["builder"]["searchable"], ["foreman_copy"])
        allow = fc.generate_subagents(res["config"])["subagents"]["agentOverrides"]["builder"]["tools"]
        self.assertNotIn("example_tool", allow)

    # ---- skills.* layers

    def test_skills_defaults(self):
        cfg = self.load()["config"]
        self.assertEqual(cfg["skills"]["visible"], [])
        self.assertEqual(cfg["skills"]["hidden"], ["pi-subagents", "pi-intercom", "council-mode", "skill-authoring"])

    def test_project_may_add_to_skills_hidden_but_not_remove(self):
        res = self.load(project={"skills": {"hidden": ["example-domain-skill"]}})
        self.assertEqual(res["config"]["skills"]["hidden"][-1], "example-domain-skill")
        self.assertIn("skill-authoring", res["config"]["skills"]["hidden"])
        res = self.load(project={"skills": {"hidden": []}})
        self.assertIn("skill-authoring", res["config"]["skills"]["hidden"])

    def test_project_and_session_may_not_set_skills_visible(self):
        res = self.load(project={"skills": {"visible": ["example-domain-skill"]}})
        self.assertEqual(res["config"]["skills"]["visible"], [])
        self.assertTrue(any("skills.visible" in w for w in res["warnings"]))
        res = self.load(session={"skills": {"visible": ["example-domain-skill"]}})
        self.assertEqual(res["config"]["skills"]["visible"], [])

    def test_user_sets_both_skill_lists(self):
        cfg = self.load(user={"skills": {"visible": ["a-*"], "hidden": []}})["config"]
        self.assertEqual(cfg["skills"], {"visible": ["a-*"], "hidden": []})

    # ---- skill filter in the agent file

    def skills_cfg(self, names, **skills):
        cfg = self.load(user={"roles": {"explorer": {"skills": names}}, "skills": skills} if skills else {"roles": {"explorer": {"skills": names}}})["config"]
        return cfg

    def test_hidden_by_config_is_not_written_to_the_agent_file(self):
        cfg = self.skills_cfg(["example-domain-skill", "other-skill"], hidden=["example-*"])
        out = fc.generate_subagents(cfg)["subagents"]["agentOverrides"]["explorer"]
        self.assertEqual(out["skills"], ["other-skill"])
        self.assertEqual(fc.split_role_skills(cfg, "explorer"), (["other-skill"], ["example-domain-skill"]))

    def test_visible_list_makes_everything_else_searchable(self):
        cfg = self.skills_cfg(["example-domain-skill", "other-skill"], visible=["other-*"], hidden=[])
        self.assertEqual(fc.split_role_skills(cfg, "explorer"), (["other-skill"], ["example-domain-skill"]))

    def test_frontmatter_visibility_search_hides_the_skill(self):
        repo = self.project / ".agents" / "skills"
        self.skill(repo, "example-domain-skill", "metadata:\n  visibility: search\n")
        self.skill(repo, "other-skill", "metadata:\n  visibility: always\n")
        self.skill(repo, "plain-skill")
        cfg = self.skills_cfg(["example-domain-skill", "other-skill", "plain-skill"])
        out = fc.generate_subagents(cfg, str(self.agent), str(self.project))["subagents"]["agentOverrides"]["explorer"]
        self.assertEqual(out["skills"], ["other-skill", "plain-skill"])

    def test_config_beats_frontmatter(self):
        repo = self.project / ".agents" / "skills"
        self.skill(repo, "example-domain-skill", "metadata:\n  visibility: search\n")
        cfg = self.skills_cfg(["example-domain-skill"], visible=["example-domain-skill"], hidden=[])
        self.assertEqual(fc.split_role_skills(cfg, "explorer", str(self.agent), str(self.project)), (["example-domain-skill"], []))

    def test_all_skills_hidden_writes_no_skills_key(self):
        cfg = self.skills_cfg(["example-domain-skill"], hidden=["example-*"])
        self.assertNotIn("skills", fc.generate_subagents(cfg)["subagents"]["agentOverrides"]["explorer"])

    def test_skill_visibility_reader_handles_missing_metadata(self):
        f = self.skill(self.project, "plain-skill")
        self.assertIsNone(fc.skill_visibility(f))
        self.assertIsNone(fc.skill_visibility(self.project / "nope" / "SKILL.md"))

    def test_shared_fixture_cases_match_the_ts_implementation(self):
        # extensions/core-adapter/test/skillvisibility.test.ts asserts the same file against skillvisibility.ts
        fixture = json.loads((ROOT / "tests" / "fixtures" / "skill-visibility-cases.json").read_text(encoding="utf-8"))
        hidden = []
        for c in fixture["cases"]:
            f = self.project / (c["name"] + ".md")
            f.write_text(c["skillMd"], encoding="utf-8")
            got = fc.skill_is_hidden({"skills": c["rules"]}, c["name"], f)
            self.assertEqual(got, c["hidden"], c["name"])
            if got:
                hidden.append(c["name"])
        self.assertEqual(hidden, fixture["expectedHidden"])


if __name__ == "__main__":
    unittest.main()
