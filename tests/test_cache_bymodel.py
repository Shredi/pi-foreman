import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402

P = "claude-bridge"


def cache(**kw):
    return {"providers": {P: {"cache": kw}}}


class ByModelTest(unittest.TestCase):
    def test_first_row_wins_over_provider_ttl(self):
        c = cache(ttlSeconds=300, billing="token",
                  byModel=[{"match": "haiku", "ttlSeconds": 120}, {"match": "claude-*", "ttlSeconds": 600}])
        self.assertEqual(fc.cache_policy(c, P, "claude-bridge/claude-opus-5-5")["ttlSeconds"], 600)
        self.assertEqual(fc.cache_policy(c, P, "claude-haiku-5-5")["ttlSeconds"], 120)
        self.assertEqual(fc.cache_policy(c, P, "other")["ttlSeconds"], 300)
        self.assertEqual(fc.cache_policy(c, P)["ttlSeconds"], 300)

    def test_request_billing_row_disables_keepalive(self):
        c = cache(ttlSeconds=300, billing="token", keepalive={"enabled": True},
                  byModel=[{"match": "gpt-*", "billing": "request"}])
        self.assertFalse(fc.cache_policy(c, P, "gpt-6")["enabled"])
        self.assertTrue(fc.cache_policy(c, P, "claude-opus-5-5")["enabled"])

    def test_preset_row_and_project_layer_drops_by_model(self):
        preset = json.loads((ROOT / "config" / "presets" / "claude-bridge.json").read_text())
        self.assertNotIn("byModel", preset["providers"][P]["cache"])  # the TTL is derived, not a row
        self.assertEqual(fc.cache_policy({"providers": preset["providers"]}, P, "claude-opus-5-5", 3600)["ttlSeconds"], 3600)
        self.assertIn((("providers", "*", "cache", "byModel")), [k for k, _w in fc.IGNORED_KEYS])


if __name__ == "__main__":
    unittest.main()
