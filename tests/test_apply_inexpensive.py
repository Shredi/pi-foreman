import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402


def ranks(*rows):
    return [{"match": m, "tier": t} for m, t in rows]


BRIDGE = {"claude-bridge": {"ranks": ranks(("claude-fable-5-1", 0), ("claude-opus-5-5", 1), ("claude-sonnet-5-5", 2), ("claude-haiku-5-5", 3))}}
OPENAI = {"openai": {"ranks": ranks(("gpt-6-astra", 0), ("gpt-6.1-sol", 2), ("gpt-6-luna", 3))}}
COPILOT = {"github-copilot": {
    "cache": {"billing": "request"},
    "ranks": ranks(("claude-opus-5-5", 0), ("gpt-6-astra", 0), ("claude-sonnet-5-5", 1), ("gpt-6.1-sol", 1),
                   ("claude-haiku-5-5", 2), ("gpt-6-luna", 2))}}


class ApplyInexpensiveTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.agent = Path(tmp.name) / "agent"
        self.agent.mkdir()

    def apply(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = fc.main(["apply-preset", "inexpensive", *argv, "--agent-dir", str(self.agent)])
        return rc, out.getvalue(), err.getvalue()

    def fixture(self, providers):
        (self.agent / "foreman.json").write_text(json.dumps({"providers": providers}))

    def dry(self, *argv):
        before = sorted(p.name for p in self.agent.iterdir())
        rc, out, err = self.apply("--dry-run", *argv)
        self.assertEqual(sorted(p.name for p in self.agent.iterdir()), before)  # nothing written
        self.assertEqual(rc, 0, err)
        return dict(line.split(" -> ")[0:2] for line in out.splitlines() if " -> " in line)

    def test_bridge_style_ranks(self):
        self.fixture(BRIDGE)
        m = self.dry()
        p = "claude-bridge/"
        self.assertEqual(m["foreman"], p + "claude-opus-5-5 (tier 1)")
        self.assertEqual(m["session-foreman"], m["foreman"])
        self.assertEqual(m["reviewer"], m["foreman"])
        for r in ("builder", "explorer"):
            self.assertEqual(m[r], p + "claude-sonnet-5-5 (tier 2)")
        self.assertEqual(m["auto-review"], p + "claude-haiku-5-5 (tier 3)")

    def test_openai_style_ranks_with_gaps(self):
        self.fixture(OPENAI)
        m = self.dry()
        self.assertEqual(m["foreman"], "openai/gpt-6.1-sol (tier 1)")
        self.assertEqual(m["builder"], "openai/gpt-6-luna (tier 2)")
        self.assertEqual(m["auto-review"], "openai/gpt-6-luna (tier 2)")

    def test_copilot_style_ranks_several_families(self):
        self.fixture(COPILOT)
        m = self.dry()
        self.assertEqual(m["foreman"], "github-copilot/claude-sonnet-5-5 (tier 1)")
        self.assertEqual(m["builder"], "github-copilot/claude-haiku-5-5 (tier 2)")
        self.assertEqual(m["auto-review"], "github-copilot/claude-haiku-5-5 (tier 2)")

    def test_foreman_flag_picks_tier_one_model(self):
        self.fixture(COPILOT)
        m = self.dry("--foreman", "github-copilot/gpt-6.1-sol")
        self.assertEqual(m["foreman"], "github-copilot/gpt-6.1-sol (tier 1)")
        self.assertEqual(m["reviewer"], m["foreman"])
        self.assertTrue(m["builder"].endswith("(tier 2)"))
        # the flag alone picks the provider: no foreman.json needed when the ranks are there
        self.fixture(OPENAI)
        self.assertEqual(self.dry("--foreman", "openai/gpt-6-astra")["foreman"], "openai/gpt-6-astra (tier 0)")

    def test_missing_ranks_is_a_clear_error(self):
        self.fixture({"openai": {"roles": {"builder": {"model": "openai/gpt-6-luna"}}}})
        rc, out, err = self.apply("--dry-run", "--foreman", "openai/gpt-6-luna")
        self.assertEqual(rc, 1)
        self.assertIn("providers.openai.ranks is missing", err)
        rc, _o, err = self.apply("--dry-run")
        self.assertEqual(rc, 1)
        self.assertIn("cannot pick the active provider", err)
        self.assertEqual(sorted(p.name for p in self.agent.iterdir()), ["foreman.json"])

    def test_unranked_tier_has_no_model_error(self):
        self.fixture({"p": {"ranks": ranks(("big-*", 0), ("mid-*", 1), ("small-*", 2))}})
        rc, _o, err = self.apply("--dry-run")
        self.assertEqual(rc, 1)
        self.assertIn("literal ranks match", err)

    def test_apply_writes_valid_config_with_static_keys(self):
        self.fixture(BRIDGE)
        rc, _o, err = self.apply()
        self.assertEqual(rc, 0, err)
        got = json.loads((self.agent / "foreman.json").read_text())
        self.assertNotIn("rankTiers", got)
        self.assertEqual(got["childMaxThinking"], "medium")
        self.assertEqual(got["ceremony"], {"planReview": {"heavy": True}})
        self.assertIs(got["retro"]["enabled"], False)
        self.assertEqual(got["compaction"], {"maxTokens": 100000})
        self.assertEqual(got["ladder"]["rolePolicy"], {"reviewer": "at-or-below", "builder": "below"})
        prov = got["providers"]["claude-bridge"]
        self.assertEqual(prov["roles"]["builder"]["model"], "claude-bridge/claude-sonnet-5-5")
        self.assertEqual(prov["review"]["model"], "claude-bridge/claude-haiku-5-5")
        self.assertEqual(fc.load_config(agent_dir=str(self.agent))["errors"], [])


if __name__ == "__main__":
    unittest.main()
