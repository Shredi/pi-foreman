"""bridge.promptCacheTtl: the derived claude-bridge TTL (shared fixture with the TS policy test) and its config layers."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import _isolation  # noqa: E402,F401
import foreman_config as fc  # noqa: E402

CASES = json.loads((ROOT / "tests" / "fixtures" / "bridge_ttl_cases.json").read_text())["cases"]


def skip_of(pol):
    """The skip reason cache_policy's result implies (resolveCachePolicy's `skip` in cachepolicy.ts)."""
    if pol is None:
        return "no_entry"
    if pol["billing"] == "request":
        return "billing_request"
    if pol["ttlSeconds"] is None:
        return "ttl_unknown"
    if pol["ttlSeconds"] >= 3600:
        return "ttl_long"
    return None if pol["enabled"] else "disabled"


class SharedCasesTest(unittest.TestCase):
    def test_cases(self):
        for c in CASES:
            with self.subTest(c["name"]):
                bridge = fc.derived_bridge_ttl(c["cfg"], c["isChild"], c["env"])
                pol = fc.warm_policy(c["cfg"], c["provider"], c["model"], bridge)
                want = c["expect"]
                self.assertEqual(skip_of(pol), want["skip"])
                self.assertEqual(pol["ttlSeconds"] if pol else None, want["ttlSeconds"])
                self.assertEqual(pol["billing"] if pol else None, want["billing"])
                self.assertEqual(bool(pol and pol["selfWarm"]), want["selfWarm"])

    def test_signature_without_bridge_ttl_is_unchanged(self):
        self.assertEqual(fc.cache_policy({}, "claude-bridge"), {"ttlSeconds": 300, "billing": "token", "enabled": True})


class ConfigLayerTest(unittest.TestCase):
    def load(self, user=None, project=None, session=None):
        with tempfile.TemporaryDirectory() as agent, tempfile.TemporaryDirectory() as proj:
            if user is not None:
                (Path(agent) / "foreman.json").write_text(json.dumps(user))
            if project is not None:
                (Path(proj) / ".pi").mkdir()
                (Path(proj) / ".pi" / "foreman.json").write_text(json.dumps(project))
            return fc.load_config(agent, proj, trusted_project=project is not None,
                                  session_json=json.dumps(session) if session is not None else None)

    def test_user_layer_is_honoured(self):
        res = self.load(user={"version": 1, "bridge": {"promptCacheTtl": {"main": "5m", "subagent": "inherit"}}})
        self.assertEqual(res["config"]["bridge"]["promptCacheTtl"], {"main": "5m", "subagent": "inherit"})
        self.assertEqual(res["errors"], [])
        self.assertEqual([w for w in res["warnings"] if "promptCacheTtl" in w], [])

    def test_project_and_session_layers_are_ignored_with_a_warning(self):
        for layer in ("project", "session"):
            with self.subTest(layer):
                body = {"version": 1, "bridge": {"promptCacheTtl": {"main": "5m"}}}
                res = self.load(**{layer: body})
                self.assertNotEqual(res["config"]["bridge"].get("promptCacheTtl", {}).get("main"), "5m")
                self.assertTrue([w for w in res["warnings"] if "bridge.promptCacheTtl" in w and layer in w], res["warnings"])
                self.assertEqual(res["errors"], [])

    def test_invalid_value_falls_back_with_a_warning_and_no_error(self):
        res = self.load(user={"version": 1, "bridge": {"promptCacheTtl": {"main": "2h", "subagent": "inherit"}}})
        self.assertEqual(res["errors"], [])
        self.assertTrue([w for w in res["warnings"] if "bridge.promptCacheTtl.main" in w], res["warnings"])
        ttl = res["config"]["bridge"].get("promptCacheTtl", {})
        self.assertNotIn("main", ttl)
        self.assertEqual(ttl.get("subagent"), "inherit")
        self.assertEqual(fc.derived_bridge_ttl(res["config"], False, {}), 3600)  # the default fills it
        self.assertIsNone(fc.derived_bridge_ttl(res["config"], True, {}))  # inherit

    def test_non_string_value_falls_back(self):
        res = self.load(user={"version": 1, "bridge": {"promptCacheTtl": {"main": 3600, "subagent": None}}})
        self.assertEqual(res["errors"], [])
        self.assertEqual(len([w for w in res["warnings"] if "bridge.promptCacheTtl" in w]), 2, res["warnings"])

    def test_non_object_value_is_dropped_with_a_warning_and_no_error(self):
        for bad in ("1h", 3600, ["1h"], None):
            with self.subTest(repr(bad)):
                res = self.load(user={"version": 1, "bridge": {"promptCacheTtl": bad}})
                self.assertEqual(res["errors"], [])
                self.assertTrue([w for w in res["warnings"] if "bridge.promptCacheTtl" in w], res["warnings"])
                self.assertNotIn("promptCacheTtl", res["config"]["bridge"])
                self.assertEqual(fc.derived_bridge_ttl(res["config"], False, {}), 3600)

    def test_ignored_key_row_exists(self):
        self.assertIn(("bridge", "promptCacheTtl"), [k for k, _w in fc.IGNORED_KEYS])


if __name__ == "__main__":
    unittest.main()
