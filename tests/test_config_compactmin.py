"""keepalive.compactMinTokens: layer rule (higher only, default floor), schema, features doc, warm_policy mirror."""
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


def ka(**kw):
    return {"providers": {P: {"cache": {"keepalive": kw}}}}


class CompactMinLayerTest(unittest.TestCase):
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
        for f in (self.agent / "foreman.json", self.project / ".pi" / "foreman.json"):
            if f.exists():
                f.unlink()
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

    def test_user_sets_freely_including_zero(self):
        for v in (0, 5000, 400000):
            res = self.load(l2=ka(compactMinTokens=v))
            self.assertEqual(res["errors"], [])
            self.assertEqual(self.keepalive(res), {"compactMinTokens": v})

    def test_project_and_session_may_raise(self):
        for layer in ("proj", "session"):
            with self.subTest(layer=layer):
                res = self.load(l2=ka(compactMinTokens=150000), **{layer: ka(compactMinTokens=200000)})
                self.assertEqual(self.keepalive(res)["compactMinTokens"], 200000)
                res = self.load(**{layer: ka(compactMinTokens=100000)})
                self.assertEqual(self.keepalive(res)["compactMinTokens"], 100000)

    def test_project_and_session_cannot_lower(self):
        for layer in ("proj", "session"):
            with self.subTest(layer=layer):
                res = self.load(l2=ka(compactMinTokens=150000), **{layer: ka(compactMinTokens=50000)})
                self.assertEqual(self.keepalive(res)["compactMinTokens"], 150000)
                self.warned(res, "compactMinTokens ignored: it would loosen the policy")

    def test_default_is_the_floor_without_an_earlier_value(self):
        for layer in ("proj", "session"):
            with self.subTest(layer=layer):
                for v in (0, 99999):
                    res = self.load(**{layer: ka(compactMinTokens=v)})
                    self.assertEqual(self.keepalive(res), {})
                    self.warned(res, "compactMinTokens ignored: below the default 100000")


class CompactMinSurfaceTest(unittest.TestCase):
    def test_schema_features_and_docs(self):
        schema = json.loads((ROOT / "config" / "foreman.schema.json").read_text())
        keepalive = schema["properties"]["providers"]["additionalProperties"]["properties"]["cache"]["properties"]["keepalive"]["properties"]
        self.assertEqual(keepalive["compactMinTokens"]["type"], "integer")
        self.assertEqual(keepalive["compactMinTokens"]["minimum"], 0)
        feats = json.loads((ROOT / "config" / "features.json").read_text())
        keys = next(f for f in feats["features"] if f["id"] == "idle-cache")["keys"]
        self.assertIn("providers.<x>.cache.keepalive.compactMinTokens", keys)
        docs = (ROOT / "docs" / "features.md").read_text()
        self.assertIn("providers.<x>.cache.keepalive.compactMinTokens", docs)
        self.assertIn("compactMinTokens", (ROOT / "docs" / "cache.md").read_text())

    def test_warm_policy_mirror(self):
        def cfg(**kw):
            return {"providers": {P: {"cache": {"keepalive": kw}}}}
        self.assertEqual(fc.warm_policy({}, P)["compactMinTokens"], 100000)
        self.assertEqual(fc.warm_policy(cfg(compactMinTokens=0), P)["compactMinTokens"], 0)
        self.assertEqual(fc.warm_policy(cfg(compactMinTokens=250000), P)["compactMinTokens"], 250000)
        self.assertEqual(fc.warm_policy(cfg(compactMinTokens="x"), P)["compactMinTokens"], 100000)
        src = (ROOT / "extensions" / "core-adapter" / "cachepolicy.ts").read_text()
        self.assertIn("clamp(ka.compactMinTokens, 0, Number.MAX_SAFE_INTEGER, 100000)", src)
        self.assertEqual(fc.LAYER_FLOOR["compactMinTokens"], 100000)


if __name__ == "__main__":
    unittest.main()
