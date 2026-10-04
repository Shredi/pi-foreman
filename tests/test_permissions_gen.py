import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402
import permissions_gen as pg  # noqa: E402


class GeneratorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.agent = Path(self.tmp.name) / "agent"
        self.agent.mkdir()
        self.project = Path(self.tmp.name) / "proj"
        (self.project / ".pi").mkdir(parents=True)

    def l2(self, data):
        (self.agent / "foreman.json").write_text(json.dumps(data))

    def render(self, perms=None):
        return pg.render(perms or {}, self.agent)

    def test_baseline_shape(self):
        out = self.render()
        p = out["permission"]
        self.assertEqual(p["*"], "ask")
        self.assertEqual(p["bash"]["*"], "ask")
        self.assertEqual(p["bash"]["git status *"], "allow")
        self.assertEqual(p["bash"]["npm test *"], "allow")
        self.assertEqual(p["bash"]["sudo *"]["action"], "deny")
        self.assertEqual(p["read"], "allow")
        self.assertEqual(p["foreman_move"], "allow")
        self.assertEqual(p["external_directory"], "ask")
        self.assertEqual(out["shellTools"]["powershell"]["commandArgument"], "command")
        self.assertEqual(p["bash"]["Remove-Item * -R*"], "ask")
        self.assertEqual(p["bash"]["rd /s*"], "ask")

    def test_order_is_catchall_allow_ask_deny(self):
        keys = list(self.render({"allow": ["make *"], "ask": ["make deploy*"], "deny": ["make nuke*"]})["permission"]["bash"])
        self.assertEqual(keys[0], "*")
        self.assertLess(keys.index("git status *"), keys.index("find * -delete*"))
        self.assertLess(keys.index("make *"), keys.index("make deploy*"))
        self.assertLess(keys.index("make deploy*"), keys.index("sudo *"))
        self.assertEqual(keys[-1], "make nuke*")

    def test_later_stricter_rule_moves_a_repeated_pattern(self):
        bash = self.render({"allow": ["sudo *"]})["permission"]["bash"]
        self.assertEqual(bash["sudo *"]["action"], "deny")
        self.assertEqual(list(bash).count("sudo *"), 1)

    def test_project_commands_allowed(self):
        bash = self.render({"projectCommands": ["make check *"]})["permission"]["bash"]
        self.assertEqual(bash["make check *"], "allow")

    def test_secret_paths_denied_and_exceptions_after(self):
        path = self.render()["permission"]["path"]
        for pat in ("*.env", "*.env.*", "*/.ssh/*", "*.pem", "*.key", "~/.aws/*", self.agent.as_posix() + "/auth.json"):
            self.assertEqual(path[pat]["action"], "deny", pat)
        keys = list(path)
        self.assertLess(keys.index("*.env.*"), keys.index("*.env.example"))
        self.assertEqual(path["*.env.example"], "allow")

    def test_extra_path_rules_and_order(self):
        keys = list(self.render({"paths": {"ask": ["*/notes/*"], "deny": ["*/vault/*"]}})["permission"]["path"])
        self.assertEqual(keys[0], "*/notes/*")
        self.assertEqual(keys[-1], "*/vault/*")

    def test_cli_uses_l1_l2_and_ignores_project(self):
        self.l2({"safety": {"permissions": {"deny": ["rm -rf /*"]}}})
        (self.project / ".pi" / "foreman.json").write_text(json.dumps({"safety": {"permissions": {"deny": ["from-project *"]}}}))
        res = fc.load_config(str(self.agent), str(self.project), False)
        perms = res["config"]["safety"]["permissions"]
        bash = pg.render(perms, self.agent)["permission"]["bash"]
        self.assertEqual(bash["rm -rf /*"]["action"], "deny")
        self.assertNotIn("from-project *", bash)

    def test_output_is_valid_for_the_permission_schema_shape(self):
        out = self.render()
        json.dumps(out)
        for state in out["permission"]["bash"].values():
            self.assertTrue(state in ("allow", "ask") or state["action"] == "deny")
        self.assertEqual(set(out), {"permission", "shellTools", "permissionReviewLog"})


class TightenTableTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.agent = Path(self.tmp.name) / "agent"
        self.agent.mkdir()
        self.project = Path(self.tmp.name) / "proj"
        (self.project / ".pi").mkdir(parents=True)

    def load(self, l2, proj=None, session=None):
        (self.agent / "foreman.json").write_text(json.dumps(l2))
        if proj is not None:
            (self.project / ".pi" / "foreman.json").write_text(json.dumps(proj))
        return fc.load_config(str(self.agent), str(self.project), proj is not None, session)

    def test_paths_union_and_project_commands_ignored(self):
        res = self.load(
            {"safety": {"permissions": {"projectCommands": ["make a *"], "paths": {"deny": ["*/a/*"]}}}},
            {"safety": {"permissions": {"projectCommands": ["make evil *"], "paths": {"deny": ["*/b/*"], "ask": ["*/c/*"]}}}})
        perms = res["config"]["safety"]["permissions"]
        self.assertEqual(perms["projectCommands"], ["make a *"])
        self.assertEqual(perms["paths"]["deny"], ["*/a/*", "*/b/*"])
        self.assertEqual(perms["paths"]["ask"], ["*/c/*"])
        self.assertIn("safety.permissions.projectCommands", "\n".join(res["warnings"]))
        # the base (before project) is what the generator writes; the overlay enforces the rest
        self.assertEqual(res["basePermissions"]["paths"]["deny"], ["*/a/*"])
        self.assertEqual(res["basePermissions"]["paths"]["ask"], [])

    def test_session_layer_tightens_only(self):
        res = self.load({"safety": {"permissions": {"allow": ["x *"]}}}, None,
                        json.dumps({"safety": {"permissions": {"deny": ["s *"], "allow": ["x *", "y *"], "projectCommands": ["z"]},
                                               "children": {"mayPush": True}}}))
        s = res["config"]["safety"]
        self.assertEqual(s["permissions"]["deny"], ["s *"])
        self.assertEqual(s["permissions"]["allow"], ["x *"])
        self.assertEqual(s["permissions"]["projectCommands"], [])
        self.assertIs(s["children"]["mayPush"], False)
        self.assertIn("session safety.children.mayPush", "\n".join(res["warnings"]))


if __name__ == "__main__":
    unittest.main()
