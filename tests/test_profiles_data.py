"""Setup profiles, feature toggles and add-ons: the shipped data in config/ (features.json toggles,
profiles.json, addons.json), the `profile` key and `foreman_config.py --user-file`."""
import contextlib
import copy
import io
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import foreman_config as fc  # noqa: E402
import foreman_docs as fd  # noqa: E402

AREAS = {"install", "models", "review", "ceremony", "safety", "tools", "sessions", "ui", "retro", "ops"}
TOGGLEABLE = {"codemode", "reviewer-climb", "plan-review", "orientation", "git-tools", "pr-ops", "review-required",
              "children-may-push", "workflow-scripts", "remote-intercom", "idle-cache", "idle-downshift", "herdr",
              "footer-ui", "retro", "trace"}
RELAXATIONS = {"children-may-push", "workflow-scripts", "remote-intercom", "git-tools"}
SAFETY_FLOOR = ["safety.permissions", "safety.git", "safety.ops", "safety.requiredChildExtensions",
                "safety.preconditionOps", "ceremony.foremanEdits", "ceremony.required", "ceremony.reviewBeforePr",
                "ceremony.reviewGate", "ceremony.requireTriage", "bridge", "python", "presence.command",
                "sidebar.statusCommand", "tools.prHost", "roles.*.mcp", "roles.*.file", "paths.hubWorkflow"]
SAMPLE_USER = {"providers": {"sample": {"cache": {"ttlSeconds": 300, "billing": "token"}}}}


def expand(patch, user):
    """A toggle patch (dotted leaf -> value; `*` = every provider in `user`) as a nested config."""
    out = {}
    for key, value in patch.items():
        paths = [key.split(".")]
        if "*" in paths[0]:
            i = paths[0].index("*")
            paths = [paths[0][:i] + [name] + paths[0][i + 1:] for name in user.get(paths[0][0], {})]
        for segs in paths:
            node = out
            for s in segs[:-1]:
                node = node.setdefault(s, {})
            node[segs[-1]] = value
    return out


def project_may_set(leaf, value):
    """True, False, or "ignored": can the project layer write `value` at `leaf`? From foreman_config's tables."""
    if leaf[0] == "safety":
        rest = leaf[1:]
        if rest in fc.LOOSEN_ONLY:
            return False
        for keys, rule in fc.TIGHTEN.items():
            if fd._keys_match(keys, rest):
                return _rule_allows(rule, value)
        return False
    for keys, _why in fc.IGNORED_KEYS:
        if fd._keys_match(keys, leaf):
            return "ignored"
    for keys, rule in fc.LAYER_TIGHTEN:
        if fd._keys_match(keys, leaf):
            return _rule_allows(rule, value)
    if fc.CODEMODE_FALSE_ONLY and leaf[-1] == "codemode" and leaf[0] in ("roles", "providers"):
        return value is False
    return True


def _rule_allows(rule, value):
    if rule == "false_only":
        return value is False
    if rule == "true_only":
        return value is True
    return True


class ProfilesData(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.map = fd.load_features()
        cls.features = cls.map["features"]
        cls.defaults = fd.load_defaults()
        cls.schema = json.loads(fd.read(fc.SCHEMA_PATH))
        cls.toggles = {f["id"]: f["toggle"] for f in cls.features if f.get("toggle")}
        cls.profiles = fd.load_profiles()["profiles"]
        cls.addons = json.loads(fd.read(ROOT / "config" / "addons.json"))

    def errors(self, cfg):
        issues = []
        fc.validate_schema(cfg, self.schema, "", issues)
        return [i for i in issues if i[0] == "error"]

    def shipped(self, toggle):
        if toggle.get("shipped"):
            return toggle["shipped"]
        return [s for s in ("on", "off") if self.matches_defaults(toggle[s])][0]

    def matches_defaults(self, patch):
        return all(fd.lookup(self.defaults, fd.split(k)) == [v] for k, v in patch.items())

    def test_every_feature_has_a_valid_area(self):
        bad = [f["id"] for f in self.features if f.get("area") not in AREAS]
        self.assertEqual(bad, [])

    def test_toggleable_set(self):
        self.assertEqual(set(self.toggles), TOGGLEABLE)
        for t in self.toggles.values():
            self.assertLessEqual(set(t), {"on", "off", "relaxes", "shipped"})
            self.assertEqual(set(t["on"]), set(t["off"]))

    def test_toggles_validate_write_their_leaves_and_flip_the_switch(self):
        bad = []
        for f in self.features:
            t = f.get("toggle")
            if not t:
                continue
            states = {}
            for side in ("on", "off"):
                patch = expand(t[side], SAMPLE_USER)
                merged = fc.deep_merge(fc.deep_merge(self.defaults, SAMPLE_USER), patch)
                if self.errors(merged):
                    bad.append((f["id"], side, self.errors(merged)))
                for key, value in t[side].items():
                    got = fd.lookup(merged, fd.split(key))
                    if not got or any(v != value for v in got):
                        bad.append((f["id"], side, "leaf not written", key))
                states[side] = fd.switch_on(f, merged)
            sw = f.get("switch")
            if sw and any(fd.pattern_matches(sw["key"], fd.split(k)) or sw["key"] == k for k in t["on"]):
                if states != {"on": True, "off": False}:
                    bad.append((f["id"], "switch", states))
        self.assertEqual(bad, [])

    def test_shipped_state_rule(self):
        bad = []
        for fid, t in self.toggles.items():
            sides = [s for s in ("on", "off") if self.matches_defaults(t[s])]
            if "shipped" in t:
                self.assertEqual(fid, "idle-cache")
                self.assertEqual(t["shipped"], "on")
                if any(fd.lookup(self.defaults, fd.split(k)) for k in t["on"]):
                    bad.append((fid, "declared shipped but the leaf has a default"))
            elif len(sides) != 1:
                bad.append((fid, "sides equal to the defaults", sides))
        self.assertEqual(bad, [])
        self.assertEqual({fid for fid, t in self.toggles.items() if "shipped" in t}, {"idle-cache"})
        self.assertEqual((self.toggles["retro"]["on"], self.toggles["retro"]["off"]),
                         ({"retro.enabled": None}, {"retro.enabled": False}))
        self.assertEqual((self.toggles["trace"]["on"], self.toggles["trace"]["off"]),
                         ({"trace.enabled": None}, {"trace.enabled": False}))

    def test_no_toggle_leaf_is_in_the_safety_floor(self):
        bad = []
        for fid, t in self.toggles.items():
            for key in list(t["on"]) + list(t["off"]):
                leaf = fd.split(key)
                for pat in SAFETY_FLOOR:
                    if fd.pattern_matches(pat, leaf[:len(fd.split(pat))]) and len(leaf) >= len(fd.split(pat)):
                        bad.append((fid, key, pat))
        self.assertEqual(bad, [])

    def test_relaxes_equals_the_derived_set(self):
        derived = set()
        for fid, t in self.toggles.items():
            other = "off" if self.shipped(t) == "on" else "on"
            for key, value in t[other].items():
                if project_may_set(fd.split(key), value) is False:
                    derived.add(fid)
        flagged = {fid for fid, t in self.toggles.items() if t.get("relaxes")}
        self.assertEqual(derived, RELAXATIONS)
        self.assertEqual(flagged, derived)

    def test_profiles_name_toggleable_ids_only(self):
        self.assertEqual(set(self.profiles), {"orchestration", "standard", "full"})
        for name, p in self.profiles.items():
            self.assertEqual(set(p["features"]) - set(self.toggles), set(), name)
            self.assertTrue(all(isinstance(v, bool) for v in p["features"].values()), name)
            self.assertTrue(p["title"] and p["summary"], name)
        self.assertEqual({i for i, v in self.profiles["orchestration"]["features"].items() if not v},
                         {"pr-ops", "herdr", "footer-ui", "idle-cache", "idle-downshift", "retro", "trace"})
        self.assertEqual(self.profiles["standard"]["features"], {})
        self.assertEqual(self.profiles["full"]["features"], {i: True for i in self.toggles})

    def test_relaxations_are_in_no_off_list_and_off_in_orchestration_and_standard(self):
        for name, p in self.profiles.items():
            off = {i for i, v in p["features"].items() if not v}
            self.assertEqual(off & RELAXATIONS, set(), name)
        for name in ("orchestration", "standard"):
            named = self.profiles[name]["features"]
            for fid in RELAXATIONS:
                state = ("on" if named[fid] else "off") if fid in named else self.shipped(self.toggles[fid])
                self.assertEqual(state, "off", (name, fid))

    def test_addons_exact_versions_and_no_recommended(self):
        self.assertEqual(self.addons["version"], 1)
        entries = self.addons["addons"]
        self.assertEqual([a["id"] for a in entries], ["polish", "background-tasks"])
        self.assertEqual({a["id"]: (a["package"], a["version"]) for a in entries},
                         {"polish": ("pi-polish", "0.1.2"), "background-tasks": ("pi-background-tasks", "2.6.10")})
        for a in entries:
            self.assertNotIn("recommended", a)
            self.assertRegex(a["version"], r"^\d+\.\d+\.\d+$")
            self.assertRegex(a["package"], r"^(@[a-z0-9-~][a-z0-9-._~]*/)?[a-z0-9-~][a-z0-9-._~]*$")
            self.assertTrue(a["purpose"] and isinstance(a["clashes"], list))
        env = {a["id"]: a.get("env") for a in entries}
        self.assertEqual(env["background-tasks"], {"PI_BG_FEATURES": "process"})

    def test_profiles_feature_and_generated_tables(self):
        f = next(x for x in self.features if x["id"] == "profiles")
        self.assertEqual((f["area"], f["keys"]), ("install", ["profile"]))
        self.assertEqual(f["commands"], ["foreman setup --profile", "foreman setup --pick", "foreman features"])
        text = fd.render()
        self.assertIn("## Profiles", text)
        self.assertIn("| Feature | Area | Toggle |", text)
        self.assertIn("| `orchestration` |", text)


class ProfileKeyAndUserFile(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name).resolve()
        self.agent = root / "agent"
        self.agent.mkdir()
        self.project = root / "proj"
        (self.project / ".pi").mkdir(parents=True)
        (self.project / ".git").mkdir()
        self.root = root

    def write(self, path, data):
        Path(path).write_text(json.dumps(data))

    def cli(self, *args):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = fc.main(list(args))
        return code, json.loads(buf.getvalue())

    def test_default_is_null_and_user_and_overlay_accept_it(self):
        self.assertIsNone(fc.load_config(agent_dir=str(self.agent))["config"]["profile"])
        self.write(self.agent / "foreman.json", {"profile": "standard"})
        res = fc.load_config(agent_dir=str(self.agent))
        self.assertEqual((res["config"]["profile"], res["errors"], res["warnings"]), ("standard", [], []))
        self.write(self.agent / "foreman.json", {})
        self.write(self.root / "overlay.json", {"profile": "full"})
        res = fc.load_config(agent_dir=str(self.agent), l3_paths=[str(self.root / "overlay.json")])
        self.assertEqual((res["config"]["profile"], res["errors"]), ("full", []))

    def test_project_and_session_profile_dropped_with_a_warning(self):
        self.write(self.agent / "foreman.json", {"profile": "standard"})
        self.write(self.project / ".pi" / "foreman.json", {"profile": "full"})
        res = fc.load_config(agent_dir=str(self.agent), project_dir=str(self.project), trusted_project=True,
                             session_json=json.dumps({"profile": "orchestration"}))
        self.assertEqual(res["config"]["profile"], "standard")
        text = "\n".join(res["warnings"])
        self.assertIn("project profile ignored: the project may not set this key", text)
        self.assertIn("session profile ignored: the session may not set this key", text)
        self.assertEqual(fd.layer_rule(("profile",))[:18], "not in project/ses")

    def test_schema_rejects_a_non_string_profile(self):
        self.write(self.agent / "foreman.json", {"profile": 3})
        self.assertTrue(fc.load_config(agent_dir=str(self.agent))["errors"])

    def test_user_file_replaces_only_the_user_layer(self):
        self.write(self.agent / "foreman.json", {"profile": "standard"})
        cand = self.root / "candidate.json"
        self.write(cand, {"profile": "orchestration", "tools": {"pr": False}})
        code, out = self.cli("merged", "--json", "--agent-dir", str(self.agent), "--user-file", str(cand))
        self.assertEqual(code, 0)
        self.assertEqual((out["config"]["profile"], out["config"]["tools"]["pr"]), ("orchestration", False))
        self.assertIn("L2", out["layers"])
        code, out = self.cli("merged", "--json", "--agent-dir", str(self.agent))
        self.assertEqual(out["config"]["profile"], "standard")

    def test_user_file_validate_reports_a_schema_error(self):
        cand = self.root / "bad.json"
        self.write(cand, {"profile": 3})
        code, out = self.cli("validate", "--json", "--agent-dir", str(self.agent), "--user-file", str(cand))
        self.assertEqual(code, 1)
        self.assertTrue(out["errors"])

    def test_user_file_missing_adds_no_layer(self):
        code, out = self.cli("validate", "--json", "--agent-dir", str(self.agent),
                             "--user-file", str(self.root / "absent.json"))
        self.assertEqual((code, "L2" in out["layers"]), (0, False))


if __name__ == "__main__":
    unittest.main()
