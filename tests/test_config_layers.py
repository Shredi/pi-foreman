"""Project and session layers cannot loosen non-safety keys; invalid layer values drop alone
(security review S3, S4, S5)."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402


class LayerRulesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(os.path.realpath(self.tmp.name))
        self.agent = root / "agent"
        self.agent.mkdir()
        self.project = root / "proj"
        (self.project / ".pi").mkdir(parents=True)
        (self.project / ".git").mkdir()
        self.outside = root / "outside"
        self.outside.mkdir()

    def write(self, path, data):
        path.write_text(json.dumps(data))

    def load(self, proj=None, session=None, l2=None, l3=None):
        if l2 is not None:
            self.write(self.agent / "foreman.json", l2)
        if proj is not None:
            self.write(self.project / ".pi" / "foreman.json", proj)
        l3_paths = []
        if l3 is not None:
            self.write(Path(self.tmp.name) / "l3.json", l3)
            l3_paths = [str(Path(self.tmp.name) / "l3.json")]
        return fc.load_config(agent_dir=str(self.agent), project_dir=str(self.project),
                              trusted_project=True, l3_paths=l3_paths,
                              session_json=json.dumps(session) if session is not None else None)

    def test_python_path_only_from_l1_l3_l2(self):
        res = self.load(l2={"python": {"path": "/opt/py/bin/python3"}},
                        proj={"python": {"path": "/tmp/evil"}})
        self.assertEqual(res["config"]["python"]["path"], "/opt/py/bin/python3")
        self.assertIn("project python.path ignored", "\n".join(res["warnings"]))
        res = self.load(session={"python": {"path": "/tmp/evil"}})
        self.assertEqual(res["config"]["python"]["path"], "/opt/py/bin/python3")
        self.assertIn("session python.path ignored", "\n".join(res["warnings"]))

    def test_roles_narrow_only_and_no_new_ids(self):
        res = self.load(proj={"roles": {
            "explorer": {"tools": ["read", "edit", "write"], "launch": "detached"},
            "intruder": {"tools": ["bash", "edit"]}}},
            session={"roles": {"reviewer": {"tools": ["read", "foreman_move"]}}})
        roles = res["config"]["roles"]
        self.assertEqual(roles["explorer"]["tools"], ["read"])
        self.assertEqual(roles["reviewer"]["tools"], ["read"])
        self.assertNotIn("intruder", roles)
        joined = "\n".join(res["warnings"])
        for key in ("roles.explorer.tools: entries not extended: edit, write", "roles.intruder ignored",
                    "roles.explorer.launch ignored", "roles.reviewer.tools: entries not extended: foreman_move"):
            self.assertIn(key, joined)

    def test_role_file_ignored_prompt_append_kept(self):
        res = self.load(l2={"roles": {"builder": {"file": "/opt/roles/builder.md"}}},
                        proj={"roles": {"builder": {"file": "evil.md", "promptAppend": "repo note"}}},
                        session={"roles": {"explorer": {"file": "evil2.md"}}})
        roles = res["config"]["roles"]
        self.assertEqual(roles["builder"]["file"], "/opt/roles/builder.md")
        self.assertEqual(roles["builder"]["promptAppend"], "repo note")
        self.assertNotIn("file", roles["explorer"])
        joined = "\n".join(res["warnings"])
        self.assertIn("project roles.builder.file ignored", joined)
        self.assertIn("session roles.explorer.file ignored", joined)

    def test_codemode_only_switched_off(self):
        res = self.load(l2={"providers": {"p1": {"roles": {"builder": {"model": "p1/b"},
                                                           "explorer": {"model": "p1/e", "codemode": True}}}}},
                        proj={"roles": {"builder": {"codemode": True}, "explorer": {"codemode": False}},
                              "providers": {"p1": {"roles": {"builder": {"codemode": True},
                                                             "explorer": {"codemode": False}}}}})
        cfg = res["config"]
        self.assertIs(cfg["roles"]["builder"]["codemode"], False)
        self.assertIs(cfg["roles"]["explorer"]["codemode"], False)
        self.assertNotIn("codemode", cfg["providers"]["p1"]["roles"]["builder"])
        self.assertIs(cfg["providers"]["p1"]["roles"]["explorer"]["codemode"], False)
        joined = "\n".join(res["warnings"])
        self.assertIn("project roles.builder.codemode ignored", joined)
        self.assertIn("project providers.p1.roles.builder.codemode ignored", joined)

    def test_provider_roles_for_unknown_ids_ignored(self):
        res = self.load(proj={"providers": {"p1": {"roles": {"intruder": {"model": "p1/x"},
                                                             "builder": {"model": "p1/b"}}}}})
        proles = res["config"]["providers"]["p1"]["roles"]
        self.assertEqual(set(proles), {"builder"})
        self.assertIn("project providers.p1.roles.intruder ignored", "\n".join(res["warnings"]))

    def test_project_still_picks_models_and_fallback(self):
        res = self.load(proj={"providers": {"p1": {"roles": {"builder": {"model": "p1/b"}},
                                                   "fallback": {"provider": "p2"}}}})
        p1 = res["config"]["providers"]["p1"]
        self.assertEqual(p1["roles"]["builder"]["model"], "p1/b")
        self.assertEqual(p1["fallback"], {"provider": "p2"})
        self.assertEqual(res["errors"], [])

    def test_invalid_project_value_keeps_lower_tightening(self):
        res = self.load(l3={"safety": {"permissions": {"deny": ["curl *"]}}},
                        l2={"safety": {"git": {"protectedBranches": ["release"]}}},
                        proj={"safety": {"children": {"mayPush": "no"},
                                         "permissions": {"deny": ["wget *", 7]}}})
        s = res["config"]["safety"]
        self.assertFalse(res["safetyFallback"])
        self.assertEqual(s["permissions"]["deny"], ["curl *", "wget *"])
        self.assertEqual(s["git"]["protectedBranches"], ["release"])
        joined = "\n".join(res["warnings"])
        self.assertIn("project invalid safety value dropped: safety.children.mayPush", joined)
        self.assertIn("project invalid safety value dropped: safety.permissions.deny[1]", joined)

    def test_trace_dir_must_stay_in_workspace(self):
        res = self.load(proj={"trace": {"dir": "logs/trace"}})
        self.assertEqual(res["config"]["trace"]["dir"], "logs/trace")
        values = [str(self.outside), "../outside"]
        try:
            os.symlink(str(self.outside), str(self.project / "escape"), target_is_directory=True)
            values.append("escape/x")
        except OSError:  # Windows without symlink rights
            pass
        for value in values:
            res = self.load(proj={"trace": {"dir": value}})
            self.assertIsNone(res["config"]["trace"]["dir"], value)
            self.assertIn("project trace.dir ignored", "\n".join(res["warnings"]))

    def test_trace_dir_not_in_git_or_pi(self):
        for value in [".git/hooks", ".pi", "sub/.GIT/x", ".pi/agents"]:
            res = self.load(proj={"trace": {"dir": value}})
            self.assertIsNone(res["config"]["trace"]["dir"], value)
            self.assertIn("must not be inside a .git or .pi directory", "\n".join(res["warnings"]))


if __name__ == "__main__":
    unittest.main()
