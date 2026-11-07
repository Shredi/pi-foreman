"""keepalive.enabled is the only warming switch: the deprecated keys are accepted and change neither `keepaliveOwned`
nor the other warm_policy fields the new model reads; the shipped presets set none of them (docs/cache.md)."""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402

P = "claude-bridge"
DEPRECATED = {"beyondPiCap": False, "windowMinutes": 5, "selfWarmWindowMinutes": 5, "awayTicks": 3, "whileWaiting": False, "intervalSeconds": 60}


def cfg(ttl=3600, billing="token", **keepalive):
    return {"providers": {P: {"cache": {"ttlSeconds": ttl, "billing": billing, "keepalive": keepalive}}}}


class DeprecatedKeysTest(unittest.TestCase):
    def test_keepalive_enabled_is_the_only_switch(self):
        self.assertTrue(fc.warm_policy(cfg(enabled=True), P, "m", None)["keepaliveOwned"])
        self.assertFalse(fc.warm_policy(cfg(), P, "m", None)["keepaliveOwned"])
        self.assertFalse(fc.warm_policy(cfg(enabled=False), P, "m", None)["keepaliveOwned"])
        self.assertFalse(fc.warm_policy(cfg(billing="request", enabled=True), P, "m", None)["keepaliveOwned"])
        self.assertFalse(fc.warm_policy(cfg(ttl=10, enabled=True), P, "m", None)["keepaliveOwned"])
        self.assertTrue(fc.warm_policy(cfg(ttl=11, enabled=True), P, "m", None)["keepaliveOwned"])

    def test_each_deprecated_key_is_ignored(self):
        base = fc.warm_policy(cfg(enabled=True), P, "m", None)
        self.assertTrue(base["keepaliveOwned"])
        for key, value in DEPRECATED.items():
            got = fc.warm_policy(cfg(enabled=True, **{key: value}), P, "m", None)
            for field in ("keepaliveOwned", "ttlSeconds", "billing", "enabled", "budgetShare", "compactMinTokens"):
                self.assertEqual(got[field], base[field], (key, field))

    def test_presets_set_no_deprecated_key(self):
        presets = sorted((ROOT / "config" / "presets").glob("*.json"))
        self.assertTrue(presets)
        for path in presets:
            data = json.loads(path.read_text())
            for name, prov in (data.get("providers") or {}).items():
                ka = ((prov or {}).get("cache") or {}).get("keepalive") or {}
                self.assertEqual(sorted(set(ka) & set(DEPRECATED)), [], "%s %s" % (path.name, name))


if __name__ == "__main__":
    unittest.main()
