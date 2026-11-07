import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402

P = "github-copilot"


def cache(**kw):
    return {"providers": {P: {"cache": kw}}}


class CopilotTokenBillingTest(unittest.TestCase):
    def test_default_is_token(self):
        self.assertEqual(fc.BUILTIN_CACHE[P], {"ttlSeconds": None, "billing": "token"})
        self.assertEqual(fc.cache_policy({}, P, "claude-opus-5.5"), {"ttlSeconds": 300, "billing": "token", "enabled": True})

    def test_gpt_ids_get_1800(self):
        for m in ("gpt-6.1-sol", "gpt-6.1-terra", "gpt-5.6-luna"):
            self.assertEqual(fc.cache_policy({}, P, m), {"ttlSeconds": 1800, "billing": "token", "enabled": True}, m)

    def test_unknown_model_has_no_ttl(self):
        pol = fc.cache_policy({}, P, "gemini-3.8-flash")
        self.assertIsNone(pol["ttlSeconds"])
        self.assertFalse(pol["enabled"])

    def test_request_override(self):
        self.assertFalse(fc.cache_policy(cache(billing="request"), P, "claude-opus-5.5")["enabled"])
        c = cache(byModel=[{"match": "gpt-*", "billing": "request"}])
        self.assertEqual(fc.cache_policy(c, P, "gpt-6.1-sol")["billing"], "request")
        self.assertFalse(fc.cache_policy(c, P, "gpt-6.1-sol")["enabled"])
        self.assertTrue(fc.cache_policy(c, P, "claude-opus-5.5")["enabled"])


if __name__ == "__main__":
    unittest.main()
