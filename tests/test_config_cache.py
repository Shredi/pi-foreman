"""providers.<p>.cache: schema, layer rules (project/session may only tighten) and the python policy mirror."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402

P = "claude-bridge"


def cache(**kw):
    return {"providers": {P: {"cache": kw}}}


class CacheLayerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(os.path.realpath(self.tmp.name))
        self.agent = root / "agent"
        self.agent.mkdir()
        self.project = root / "proj"
        (self.project / ".pi").mkdir(parents=True)
        (self.project / ".git").mkdir()

    def load(self, proj=None, session=None, l2=None):
        if l2 is not None:
            (self.agent / "foreman.json").write_text(json.dumps(l2))
        if proj is not None:
            (self.project / ".pi" / "foreman.json").write_text(json.dumps(proj))
        return fc.load_config(agent_dir=str(self.agent), project_dir=str(self.project), trusted_project=True,
                              session_json=json.dumps(session) if session is not None else None)

    def got(self, res, *path):
        node = res["config"]["providers"][P]["cache"]
        for k in path:
            node = node[k]
        return node

    def warned(self, res, text):
        self.assertIn(text, "\n".join(res["warnings"]))

    def test_user_sets_all_keys(self):
        full = cache(ttlSeconds=600, billing="token", warmCompact=False,
                     keepalive={"enabled": True, "intervalSeconds": 100, "windowMinutes": 20})
        res = self.load(l2=full)
        self.assertEqual(res["errors"], [])
        self.assertEqual(res["config"]["providers"][P]["cache"], full["providers"][P]["cache"])

    def test_project_untightenable_keys_dropped(self):
        res = self.load(l2=cache(ttlSeconds=600),
                        proj=cache(ttlSeconds=60, billing="request", warmCompact=False,
                                   keepalive={"intervalSeconds": 40}))
        self.assertEqual(self.got(res, "ttlSeconds"), 600)
        for k in ("billing", "warmCompact"):
            self.assertNotIn(k, res["config"]["providers"][P]["cache"])
            self.warned(res, "project providers.%s.cache.%s ignored" % (P, k))
        self.assertNotIn("intervalSeconds", res["config"]["providers"][P]["cache"].get("keepalive", {}))
        self.warned(res, "cache.ttlSeconds ignored")
        self.warned(res, "cache.keepalive.intervalSeconds ignored")

    def test_enabled_only_false(self):
        res = self.load(l2=cache(keepalive={"enabled": True}), proj=cache(keepalive={"enabled": False}))
        self.assertIs(self.got(res, "keepalive", "enabled"), False)
        res = self.load(l2=cache(keepalive={"enabled": False}), proj=cache(keepalive={"enabled": True}))
        self.assertIs(self.got(res, "keepalive", "enabled"), False)
        self.warned(res, "keepalive.enabled ignored")

    def test_session_enabled_true_dropped(self):
        res = self.load(l2=cache(keepalive={"enabled": False}), session=cache(keepalive={"enabled": True}))
        self.assertIs(self.got(res, "keepalive", "enabled"), False)
        self.warned(res, "session providers.%s.cache.keepalive.enabled ignored" % P)

    def test_window_lower_only(self):
        res = self.load(l2=cache(keepalive={"windowMinutes": 45}), proj=cache(keepalive={"windowMinutes": 10}))
        self.assertEqual(self.got(res, "keepalive", "windowMinutes"), 10)
        res = self.load(l2=cache(keepalive={"windowMinutes": 45}), proj=cache(keepalive={"windowMinutes": 60}))
        self.assertEqual(self.got(res, "keepalive", "windowMinutes"), 45)
        self.warned(res, "windowMinutes ignored")

    def test_window_cap_without_base(self):
        res = self.load(proj=cache(keepalive={"windowMinutes": 60}))
        self.assertNotIn("windowMinutes", res["config"]["providers"][P]["cache"]["keepalive"])
        self.warned(res, "windowMinutes ignored: above the default 45")
        res = self.load(proj=cache(keepalive={"windowMinutes": 30}))
        self.assertEqual(self.got(res, "keepalive", "windowMinutes"), 30)
        res = self.load(proj=cache(keepalive={"windowMinutes": 0}))
        self.warned(res, "below the minimum 1")

    def test_non_object_nodes_dropped_without_schema_error(self):
        res = self.load(proj=cache(keepalive=False))
        self.assertEqual(res["errors"], [])
        self.assertNotIn("keepalive", res["config"]["providers"][P]["cache"])
        self.warned(res, "project providers.%s.cache.keepalive ignored: expected an object" % P)
        res = self.load(proj={"providers": {P: {"cache": 5}}})
        self.assertEqual(res["errors"], [])
        self.assertNotIn("cache", res["config"]["providers"][P])
        self.warned(res, "project providers.%s.cache ignored: expected an object" % P)


class CacheSchemaTest(unittest.TestCase):
    def issues(self, cache_value):
        schema = fc.read_json(fc.SCHEMA_PATH)
        full = fc.deep_merge(fc.read_json(fc.DEFAULTS_PATH), {"providers": {P: {"cache": cache_value}}})
        out = []
        fc.validate_schema(full, schema, "", out)
        return [m for kind, _p, m in out if kind == "error"]

    def test_valid(self):
        self.assertEqual(self.issues({"ttlSeconds": None, "billing": "request", "warmCompact": True,
                                      "keepalive": {"enabled": True, "intervalSeconds": 30, "windowMinutes": 60}}), [])

    def test_rejects(self):
        self.assertTrue(self.issues({"keepalive": {"windowMinutes": 61}}))
        self.assertTrue(self.issues({"keepalive": {"intervalSeconds": 29}}))
        self.assertTrue(self.issues({"billing": "x"}))
        self.assertTrue(self.issues({"ttlSeconds": 0}))
        self.assertTrue(self.issues({"keepalive": False}))


class CachePolicyMirrorTest(unittest.TestCase):
    def test_preset_matches_builtin(self):
        preset = json.loads((ROOT / "config" / "presets" / "claude-bridge.json").read_text())
        c = preset["providers"][P]["cache"]
        self.assertEqual({"ttlSeconds": c["ttlSeconds"], "billing": c["billing"]}, fc.BUILTIN_CACHE[P])
        self.assertIs(c["keepalive"]["enabled"], True)

    def test_builtin_matches_ts(self):
        ts = (ROOT / "extensions" / "core-adapter" / "cachepolicy.ts").read_text()
        self.assertIn('"claude-bridge": { ttlSeconds: 300, billing: "token" }', ts)
        self.assertIn('"github-copilot": { ttlSeconds: null, billing: "request" }', ts)

    def test_cache_policy(self):
        self.assertEqual(fc.cache_policy({}, P), {"ttlSeconds": 300, "billing": "token", "enabled": True})
        self.assertFalse(fc.cache_policy({}, "github-copilot")["enabled"])
        self.assertIsNone(fc.cache_policy({}, "other"))
        self.assertIsNone(fc.cache_policy(None, None))
        self.assertFalse(fc.cache_policy(cache(ttlSeconds=3600), P)["enabled"])
        self.assertFalse(fc.cache_policy(cache(keepalive={"enabled": False}), P)["enabled"])
        self.assertEqual(fc.cache_policy(cache(ttlSeconds=600), P)["ttlSeconds"], 600)


if __name__ == "__main__":
    unittest.main()
