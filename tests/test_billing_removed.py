"""`billing` (provider level or byModel row) is accepted and ignored: the Python policy mirror, the validator and the schema."""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402

P = "claude-bridge"


def cfg(**cache):
    return {"providers": {P: {"cache": cache}}}


class BillingIgnoredTest(unittest.TestCase):
    def test_policy_equal_with_and_without_billing(self):
        bases = [{"ttlSeconds": 300}, {"ttlSeconds": 300, "keepalive": {"enabled": True}},
                 {"byModel": [{"match": "gpt-*", "ttlSeconds": 600}]}]
        for base in bases:
            want_warm = fc.warm_policy(cfg(**base), P, "gpt-6", None)
            want_cache = fc.cache_policy(cfg(**base), P, "gpt-6", None)
            self.assertNotIn("billing", want_warm)
            for billing in ("request", "token", "whatever"):
                variants = [dict(base, billing=billing)]
                if "byModel" in base:
                    variants.append({"byModel": [dict(base["byModel"][0], billing=billing)]})
                for c in variants:
                    self.assertEqual(fc.warm_policy(cfg(**c), P, "gpt-6", None), want_warm, c)
                    self.assertEqual(fc.cache_policy(cfg(**c), P, "gpt-6", None), want_cache, c)

    def test_keepalive_enabled_false_still_switches_off(self):
        c = cfg(ttlSeconds=300, billing="token", keepalive={"enabled": False})
        self.assertFalse(fc.warm_policy(c, P, "m", None)["keepaliveOwned"])


class CustomProviderKeepaliveTest(unittest.TestCase):
    def custom(self, **cache):
        return {"providers": {"my-proxy": {"cache": cache}}}

    def test_off_without_the_key(self):
        for extra in ({}, {"billing": "token"}, {"billing": "request"}):
            c = self.custom(ttlSeconds=300, **extra)
            self.assertFalse(fc.cache_policy(c, "my-proxy", "m")["enabled"], extra)
            self.assertFalse(fc.warm_policy(c, "my-proxy", "m")["keepaliveOwned"], extra)

    def test_on_with_the_key(self):
        for extra in ({}, {"billing": "token"}):
            c = self.custom(ttlSeconds=300, keepalive={"enabled": True}, **extra)
            self.assertTrue(fc.warm_policy(c, "my-proxy", "m")["keepaliveOwned"], extra)

    def test_built_in_providers_on_by_default_off_with_false(self):
        for prov, model in (("claude-bridge", "m"), ("github-copilot", "claude-sonnet-5-5")):
            self.assertTrue(fc.warm_policy({}, prov, model)["keepaliveOwned"], prov)
            off = {"providers": {prov: {"cache": {"keepalive": {"enabled": False}}}}}
            self.assertFalse(fc.warm_policy(off, prov, model)["keepaliveOwned"], prov)


class BillingSchemaTest(unittest.TestCase):
    def issues(self, cache_value):
        schema = fc.read_json(fc.SCHEMA_PATH)
        full = fc.deep_merge(fc.read_json(fc.DEFAULTS_PATH), {"providers": {P: {"cache": cache_value}}})
        out = []
        fc.validate_schema(full, schema, "", out)
        return [m for kind, _p, m in out if kind == "error"]

    def test_schema_keeps_the_deprecated_property(self):
        cache = json.loads((ROOT / "config" / "foreman.schema.json").read_text())["properties"]["providers"]
        cache = cache["additionalProperties"]["properties"]["cache"]["properties"]
        self.assertIs(cache["billing"]["deprecated"], True)
        row = cache["byModel"]["items"]["properties"]["billing"]
        self.assertIs(row["deprecated"], True)


if __name__ == "__main__":
    unittest.main()
