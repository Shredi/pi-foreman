import json
import os
import re
import subprocess
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


class ConfigTest(unittest.TestCase):
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

    def l2(self, data):
        (self.agent / "foreman.json").write_text(json.dumps(data))

    def proj(self, data):
        (self.project / ".pi" / "foreman.json").write_text(json.dumps(data))

    def load(self, **kw):
        kw.setdefault("project_dir", str(self.project))
        return fc.load_config(**kw)

    def test_layer_order_last_wins(self):
        l3 = Path(self.tmp.name) / "l3.json"
        l3.write_text(json.dumps({"fanout": {"max": 5}, "maxThinking": "low"}))
        self.l2({"fanout": {"max": 2}})
        self.proj({"maxThinking": "medium"})
        res = self.load(l3_paths=[str(l3)], trusted_project=True,
                        session_json='{"maxThinking": "xhigh"}')
        self.assertEqual(res["layers"], ["L1", "L3:l3.json", "L2", "project", "session"])
        self.assertEqual(res["config"]["fanout"]["max"], 2)
        self.assertEqual(res["config"]["maxThinking"], "xhigh")
        self.assertEqual(res["errors"], [])

    def test_l3_discovery(self):
        for pkg in ("org-pkg", "@scope/other"):
            d = self.agent / "npm" / "node_modules" / pkg
            d.mkdir(parents=True)
            (d / "foreman.json").write_text(json.dumps({"fanout": {"max": 4}}))
            (d / "package.json").write_text(json.dumps(
                {"name": pkg, "pi": {"foreman": {"config": "foreman.json"}}}))
        plain = self.agent / "npm" / "node_modules" / "plain"
        plain.mkdir()
        (plain / "package.json").write_text('{"name": "plain"}')
        res = self.load()
        self.assertEqual(res["layers"], ["L1", "L3:@scope/other", "L3:org-pkg"])
        self.assertEqual(res["config"]["fanout"]["max"], 4)

    def test_project_ignored_without_trust(self):
        self.proj({"fanout": {"max": 9}})
        self.assertEqual(self.load()["config"]["fanout"]["max"], 3)
        self.assertEqual(self.load(trusted_project=True)["config"]["fanout"]["max"], 9)

    def test_project_tightens_but_never_loosens(self):
        self.l2({"safety": {"children": {"mayPush": True}, "review": {"required": True},
                            "permissions": {"deny": ["a"], "allow": ["x", "y"]}}})
        self.proj({"safety": {
            "children": {"mayPush": True},
            "review": {"required": False},
            "permissions": {"deny": ["b"], "ask": ["c"], "allow": ["y", "z"]},
            "git": {"protectedBranches": ["release"]},
            "requiredChildExtensions": ["ext"],
            "preconditionOps": {"x": 1}}})
        res = self.load(trusted_project=True)
        s = res["config"]["safety"]
        self.assertIs(s["children"]["mayPush"], True)  # L2 value stays; project cannot change it up
        self.assertIs(s["review"]["required"], True)  # project false ignored
        self.assertEqual(s["permissions"]["deny"], ["a", "b"])
        self.assertEqual(s["permissions"]["ask"], ["c"])
        self.assertEqual(s["permissions"]["allow"], ["y"])
        self.assertEqual(s["git"]["protectedBranches"], ["main", "master", "release"])
        self.assertEqual(s["requiredChildExtensions"], ["ext"])
        self.assertNotIn("preconditionOps", s)
        joined = "\n".join(res["warnings"])
        for key in ("safety.review.required", "safety.preconditionOps"):
            self.assertIn(key, joined)

    def test_project_can_tighten_booleans(self):
        self.l2({"safety": {"children": {"mayPush": True}}})
        self.proj({"safety": {"children": {"mayPush": False}, "review": {"required": True}}})
        s = self.load(trusted_project=True)["config"]["safety"]
        self.assertIs(s["children"]["mayPush"], False)
        self.assertIs(s["review"]["required"], True)

    def test_project_cannot_loosen_push_default(self):
        self.proj({"safety": {"children": {"mayPush": True}}})
        res = self.load(trusted_project=True)
        self.assertIs(res["config"]["safety"]["children"]["mayPush"], False)
        self.assertIn("safety.children.mayPush", "\n".join(res["warnings"]))

    def test_bridge_isolation_default_and_project_cannot_switch_off(self):
        self.assertEqual(self.load()["config"]["bridge"]["isolateClaudeConfig"], "auto")
        self.l2({"bridge": {"isolateClaudeConfig": False}})
        self.proj({"bridge": {"isolateClaudeConfig": True}})
        res = self.load(trusted_project=True)
        self.assertIs(res["config"]["bridge"]["isolateClaudeConfig"], False)
        self.assertIn("bridge.isolateClaudeConfig", "\n".join(res["warnings"]))

    def test_project_cannot_add_allow(self):
        self.proj({"safety": {"permissions": {"allow": ["rm *"]}}})
        res = self.load(trusted_project=True)
        self.assertEqual(res["config"]["safety"]["permissions"]["allow"], [])
        self.assertIn("safety.permissions.allow", "\n".join(res["warnings"]))

    def test_unknown_key_warns(self):
        self.l2({"bogus": 1, "fanout": {"wide": 2}})
        res = self.load()
        self.assertIn("unknown key bogus", res["warnings"])
        self.assertIn("unknown key fanout.wide", res["warnings"])
        self.assertEqual(res["errors"], [])

    def test_invalid_safety_falls_back(self):
        self.l2({"safety": {"children": {"mayPush": "yes"}, "git": {"protectedBranches": ["dev"]}}})
        res = self.load()
        self.assertTrue(res["safetyFallback"])
        self.assertEqual(res["config"]["safety"], fc.read_json(fc.DEFAULTS_PATH)["safety"])
        self.assertEqual(res["errors"], [])
        self.assertTrue(any("safety" in w for w in res["warnings"]))

    def test_invalid_other_value_is_error(self):
        self.l2({"fanout": {"max": 0}})
        res = self.load()
        self.assertFalse(res["safetyFallback"])
        self.assertTrue(res["errors"])

    def test_role_without_model_and_no_fallback_errors(self):
        self.l2({"providers": {"p1": {"roles": {"builder": {"model": "p1/b"}}}}})
        cfg = self.load()["config"]
        with self.assertRaises(fc.ConfigError) as cm:
            fc.resolve_role(cfg, "explorer", "p1")
        self.assertEqual(str(cm.exception), "role explorer has no model for provider p1 and no fallback")
        self.assertIn("error", fc.resolve_all(cfg, "p1")["explorer"])

    def test_fallback_resolves(self):
        self.l2({"providers": {
            "p1": {"roles": {"builder": {"model": "p1/b"}}, "fallback": {"provider": "p2"}},
            "p2": {"roles": {"explorer": {"model": "p2/e", "thinking": "low"}}}}})
        cfg = self.load()["config"]
        self.assertEqual(fc.resolve_role(cfg, "explorer", "p1")["model"], "p2/e")
        self.assertEqual(fc.resolve_role(cfg, "builder", "p1")["model"], "p1/b")

    def test_max_thinking_caps(self):
        self.l2({"maxThinking": "medium", "providers": {"p1": {"roles": {
            "builder": {"model": "p1/b", "thinking": "xhigh"},
            "explorer": {"model": "p1/e", "thinking": "low"}}}}})
        cfg = self.load()["config"]
        self.assertEqual(fc.resolve_role(cfg, "builder", "p1")["thinking"], "medium")
        self.assertEqual(fc.resolve_role(cfg, "explorer", "p1")["thinking"], "low")

    def test_generate_subagents_shape(self):
        self.l2({"providers": PROV})
        cfg = self.load()["config"]
        out = fc.generate_subagents(cfg)
        sub = out["subagents"]
        self.assertEqual(out["errors"], [])
        self.assertEqual(set(sub), {"agentOverridesByProvider", "agentOverrides", "forceTopLevelAsync"})
        self.assertIs(sub["forceTopLevelAsync"], True)
        self.assertEqual(set(sub["agentOverridesByProvider"]["p1"]), set(fc.CHILD_ROLES))
        self.assertEqual(sub["agentOverridesByProvider"]["p1"]["builder"],
                         {"model": "p1/m-builder", "thinking": "low"})
        self.assertNotIn("foreman", sub["agentOverrides"])
        for role, entry in sub["agentOverrides"].items():
            self.assertIsInstance(entry["tools"], list)
            self.assertEqual("codemode" in entry["tools"], role == "explorer", role)
        self.assertEqual(sub["agentOverrides"]["finalizer"]["tools"],
                         ["read", "ls", "grep", "find", "bash", "edit"])
        json.dumps(out)

    def test_provider_codemode_override_writes_provider_tools(self):
        prov = json.loads(json.dumps(PROV))
        prov["p1"]["roles"]["builder"]["codemode"] = True
        self.l2({"providers": prov})
        entry = fc.generate_subagents(self.load()["config"])["subagents"]["agentOverridesByProvider"]["p1"]
        self.assertIn("codemode", entry["builder"]["tools"])
        self.assertNotIn("tools", entry["reviewer"])

    def test_cli_contract(self):
        self.l2({"providers": PROV})
        base = [sys.executable, str(ROOT / "scripts" / "foreman_config.py")]
        env = dict(os.environ)
        r = subprocess.run(base + ["resolve", "--role", "explorer", "--provider", "p1", "--json",
                                   "--project-dir", str(self.project)],
                           capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["tools"][-1], "codemode")
        r = subprocess.run(base + ["resolve", "--role", "explorer", "--provider", "nope"],
                           capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 3)
        r = subprocess.run(base + ["merged", "--json", "--provider", "p1"],
                           capture_output=True, text=True, env=env)
        out = json.loads(r.stdout)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(out["layers"], ["L1", "L2"])
        self.assertIn("model", out["roles"]["builder"])

    def test_display_names(self):
        cfg = self.load()["config"]
        self.assertEqual(fc.display_name(cfg, "foreman"), "Picard")
        self.assertEqual(fc.display_name(cfg, "senior-reviewer"), "Sherlock")
        self.l2({"displayNames": "plain"})
        cfg = self.load()["config"]
        self.assertEqual(fc.display_name(cfg, "builder"), "builder")
        self.l2({"displayNames": "nonexistent"})
        self.assertTrue(self.load()["errors"])


class PackageFilesTest(unittest.TestCase):
    def test_package_json_private(self):
        pkg = json.loads((ROOT / "package.json").read_text())
        self.assertIs(pkg["private"], True)
        self.assertEqual(pkg["name"], "pi-foreman")

    def test_role_files(self):
        files = sorted(p.name for p in (ROOT / "agents").iterdir())
        self.assertEqual(files, sorted(r + ".md" for r in fc.CHILD_ROLES))
        for name in files:
            text = (ROOT / "agents" / name).read_text()
            front = text.split("---")[1]
            self.assertRegex(front, r"(?m)^async: true$", name)
            self.assertRegex(front, r"(?m)^name: " + re.escape(name[:-3]) + "$", name)
            self.assertIn("## Output contract", text, name)
            self.assertLessEqual(len(text.splitlines()), 30, name)

    def test_foreman_instructions_neutral(self):
        text = (ROOT / "instructions" / "foreman.md").read_text().lower()
        self.assertLessEqual(len(text.splitlines()), 60)
        for word in ("claude", "sonnet", "opus", "fable", "gpt", "gemini", "copilot", "openrouter"):
            self.assertNotIn(word, text)

    def test_defaults_validate(self):
        res = fc.load_config(agent_dir=tempfile.gettempdir() + os.sep + "pf-no-such-agent-dir")
        self.assertEqual((res["warnings"], res["errors"]), ([], []))


if __name__ == "__main__":
    unittest.main()
