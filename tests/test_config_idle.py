"""Idle downshift config: roles.foreman.idle resolves like strong, ladder.idleDownshift layer rules."""
import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402

P = "prov"


def cfg(idle=None, **extra):
    role = {"model": P + "/big", "thinking": "high"}
    if idle is not None:
        role["idle"] = idle
    out = {"providers": {P: {"roles": {"foreman": role}}}, "maxThinking": "high"}
    out.update(extra)
    return out


class ResolveIdleTest(unittest.TestCase):
    def test_idle_emitted_like_strong(self):
        r = fc.resolve_role(cfg({"model": P + "/small", "thinking": "low"}), "foreman", P)
        self.assertEqual(r["idle"], {"model": P + "/small", "thinking": "low"})
        self.assertNotIn("strong", r)

    def test_idle_thinking_is_capped(self):
        r = fc.resolve_role(cfg({"model": P + "/small", "thinking": "xhigh"}), "foreman", P)
        self.assertEqual(r["idle"]["thinking"], "high")

    def test_absent_or_malformed_idle_is_not_emitted(self):
        self.assertNotIn("idle", fc.resolve_role(cfg(), "foreman", P))
        self.assertNotIn("idle", fc.resolve_role(cfg({"thinking": "low"}), "foreman", P))

    def test_candidate_models_include_idle(self):
        entry = cfg({"model": P + "/small"})["providers"][P]
        self.assertIn("small", fc._candidate_models(entry))


class LayerRuleTest(unittest.TestCase):
    def rules(self):
        return {tuple(k): v for k, v in fc.LAYER_TIGHTEN}

    def test_rows(self):
        r = self.rules()
        self.assertEqual(r[("ladder", "idleDownshift", "enabled")], "false_only")
        self.assertEqual(r[("ladder", "idleDownshift", "causes")], "intersect")
        ignored = [k for k, _ in fc.IGNORED_KEYS]
        self.assertIn(("providers", "*", "roles", "*", "idle"), ignored)

    def test_schema(self):
        schema = json.loads((ROOT / "config" / "foreman.schema.json").read_text(encoding="utf-8"))
        props = schema["properties"]["ladder"]["properties"]["idleDownshift"]["properties"]
        self.assertEqual(set(props), {"enabled", "causes"})

    def project(self, proj):
        base = copy.deepcopy(json.loads((ROOT / "config" / "foreman.defaults.json").read_text(encoding="utf-8")))
        base["ladder"]["idleDownshift"] = {"enabled": True, "causes": ["child", "wake", "intercom", "other"]}  # the shipped default (defaults.json row pending)
        warnings = []
        res = fc.project_apply(base, copy.deepcopy(proj), warnings, "project")
        merged = res if isinstance(res, dict) else base
        return merged, warnings

    def test_project_can_only_switch_off_and_remove_causes(self):
        merged, _ = self.project({"ladder": {"idleDownshift": {"enabled": False, "causes": ["wake", "child"]}}})
        ds = merged["ladder"]["idleDownshift"]
        self.assertIs(ds["enabled"], False)
        self.assertEqual(sorted(ds["causes"]), ["child", "wake"])

    def test_project_cannot_add_causes_or_loosen(self):
        merged, _ = self.project({"ladder": {"idleDownshift": {"enabled": True, "causes": ["child", "user", "bogus"]}}})
        ds = merged["ladder"]["idleDownshift"]
        self.assertIs(ds["enabled"], True)
        self.assertEqual(ds["causes"], ["child"])

    def test_project_cannot_set_the_idle_rung(self):
        proj = {"providers": {P: {"roles": {"foreman": {"model": P + "/big", "idle": {"model": P + "/small"}}}}}}
        merged, warnings = self.project(proj)
        role = (merged.get("providers", {}).get(P, {}).get("roles", {}) or {}).get("foreman", {})
        self.assertNotIn("idle", role)
        self.assertTrue(any("idle" in w for w in warnings), warnings)

    def test_project_cannot_set_mcp_direct_providers(self):
        self.assertIn(("mcp", "directProviders"), [k for k, _ in fc.IGNORED_KEYS])
        merged, warnings = self.project({"mcp": {"directProviders": ["some-provider"]}})
        self.assertNotIn("directProviders", merged.get("mcp", {}) or {})
        self.assertTrue(any("directProviders" in w for w in warnings), warnings)


class FeaturesTest(unittest.TestCase):
    def test_feature_lists_the_keys(self):
        feats = json.loads((ROOT / "config" / "features.json").read_text(encoding="utf-8"))
        items = feats["features"] if isinstance(feats, dict) and "features" in feats else feats
        f = [x for x in items if x.get("id") == "idle-downshift"]
        self.assertEqual(len(f), 1)
        self.assertIn("ladder.idleDownshift.enabled", f[0]["keys"])
        self.assertIn("ladder.idleDownshift.causes", f[0]["keys"])


if __name__ == "__main__":
    unittest.main()
