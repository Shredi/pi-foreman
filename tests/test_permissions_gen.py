import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402
import permissions_gen as pg  # noqa: E402


OWNED = {"scratchRoot": "/tmpx/pi-foreman-scratch", "npmRoot": "/opt/npm/lib/node_modules"}


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
        return pg.render(perms or {}, self.agent, owned=OWNED)

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
        self.assertEqual(p["git_status"], "allow")
        self.assertEqual([p[t] for t in ("pr_status", "pr_checks", "pr_comments", "pr_watch")], ["allow"] * 4)
        self.assertNotIn("pr_create", p)
        self.assertEqual(p["external_directory"]["*"], "ask")
        self.assertEqual(out["shellTools"]["powershell"]["commandArgument"], "command")
        self.assertEqual(p["bash"]["Remove-Item * -R*"], "ask")
        self.assertEqual(p["bash"]["rd /s*"], "ask")

    def test_external_directory_owned_paths(self):
        a = self.agent.as_posix()
        p = self.render()["permission"]
        ext = p["external_directory"]
        self.assertEqual(list(ext)[0], "*")
        for pat in (a + "/pi-foreman/handoffs/*", a + "/sessions/*/subagent-artifacts/*", "*.worktrees/*",
                    "/tmpx/pi-foreman-scratch/*", a + "/foreman.json", a + "/settings.json"):
            self.assertEqual(ext[pat], "allow", pat)
        keys = list(ext)
        for tail in ("/parent", "/child"):
            pat = a + "/pi-foreman/handoffs/*" + tail
            self.assertEqual(ext[pat], "ask")
            self.assertLess(keys.index(a + "/pi-foreman/handoffs/*"), keys.index(pat))
        self.assertEqual(keys[-2:], [a + "/pi-foreman/handoffs/*/parent", a + "/pi-foreman/handoffs/*/child"])
        read = p["external_directory_read"]
        for pat in (a + "/pi-foreman/*", "/opt/npm/lib/node_modules", "/opt/npm/lib/node_modules/*"):
            self.assertEqual(read[pat], "allow", pat)
        self.assertNotIn(a + "/pi-foreman/*", ext)

    def test_install_releases_and_async_run_root_read_patterns(self):
        a = Path(self.agent).as_posix()
        owned = dict(OWNED, tmpRoot="/tmpx")
        read = pg.render({}, self.agent, owned=owned)["permission"]["external_directory_read"]
        for pat in (a + "/install/releases", a + "/install/releases/*",
                    "/tmpx/pi-subagents-uid-*/async-subagent-runs", "/tmpx/pi-subagents-uid-*/async-subagent-runs/*"):
            self.assertEqual(read[pat], "allow", pat)
        # the run-root patterns are dropped when tmpRoot does not resolve; the install ones stay
        read = pg.render({}, self.agent, owned=OWNED)["permission"]["external_directory_read"]
        self.assertEqual([k for k in read if "async-subagent-runs" in k], [])
        self.assertIn(a + "/install/releases/*", read)

    def test_default_owned_has_tmp_root(self):
        owned = pg.default_owned()
        self.assertTrue(owned["scratchRoot"].startswith(owned["tmpRoot"] + "/"))

    def test_unresolved_npm_root_drops_its_patterns(self):
        p = pg.render({}, self.agent, owned={"scratchRoot": "/t/pi-foreman-scratch", "npmRoot": None})["permission"]
        self.assertEqual([k for k in p["external_directory_read"] if "node_modules" in k], [])
        self.assertNotIn("{npmRoot}/*", p["external_directory_read"])

    def test_git_worktree_subcommands(self):
        bash = self.render()["permission"]["bash"]
        for sub in ("add", "list", "prune", "lock", "unlock", "move", "repair"):
            self.assertEqual(bash["git worktree %s *" % sub], "allow", sub)
        self.assertEqual(bash["git worktree remove *"], "ask")

    def test_foreman_fetch_and_install_rows(self):
        bash = self.render()["permission"]["bash"]
        for pat in ("npm ci", "npm install"):
            self.assertEqual(bash[pat], "allow", pat)
        # no bare wildcard and no package-taking install (`npm install -g x`)
        self.assertEqual(bash["*"], "ask")
        self.assertNotIn("npm install *", bash)
        self.assertNotIn("npm ci *", bash)

    def test_no_git_fetch_wildcard_row(self):
        bash = self.render()["permission"]["bash"]
        self.assertNotIn("git fetch *", bash)
        self.assertEqual([k for k in bash if k.startswith("git fetch") and "*" in k], [])

    def test_no_git_fetch_row_at_all(self):
        bash = self.render()["permission"]["bash"]
        self.assertEqual([k for k in bash if k.startswith("git fetch")], [])
        self.assertEqual(bash["*"], "ask")

    def test_default_owned_uses_realpath_tmpdir(self):
        owned = pg.default_owned()
        self.assertTrue(owned["scratchRoot"].endswith("/pi-foreman-scratch"))

    def test_resolve_npm_root_paths(self):
        class R:
            def __init__(self, code, out):
                self.returncode, self.stdout = code, out
        which = lambda n: "/usr/local/bin/" + n
        self.assertEqual(pg.resolve_npm_root(run=lambda *a, **k: R(0, "/x/lib/node_modules\n"), env={}, platform="linux", which=which), "/x/lib/node_modules")
        fail = lambda *a, **k: R(1, "")
        self.assertEqual(pg.resolve_npm_root(run=fail, env={"npm_config_prefix": "/p"}, platform="linux", which=which), "/p/lib/node_modules")
        self.assertEqual(pg.resolve_npm_root(run=fail, env={"APPDATA": "C:/Roam"}, platform="win32", which=which),
                         "C:/Roam/npm/node_modules")
        self.assertIsNone(pg.resolve_npm_root(run=fail, env={}, platform="win32", which=which))

    def test_no_sed_glob_so_every_sed_asks(self):
        # sed takes w, e, r with no blank before the file or command: no glob can allow only prints
        bash = self.render()["permission"]["bash"]
        self.assertEqual([k for k in bash if k.startswith("sed")], [])

    def test_ledger_helper_entries_only_unless_off(self):
        p = self.render()["permission"]
        self.assertEqual(p["foreman_ledger"], "allow")
        self.assertEqual(p["bash"]["ledger defer *"], "allow")
        off = pg.render({}, self.agent, "off")["permission"]
        self.assertNotIn("foreman_ledger", off)
        self.assertNotIn("ledger defer *", off["bash"])
        self.assertEqual(off["bash"]["ledger note *"], "allow")

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
        self.assertEqual(set(out), {"permission", "shellTools", "permissionReviewLog", "authorizerChain"})
        self.assertEqual(out["authorizerChain"], ["foreman-review"])


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
