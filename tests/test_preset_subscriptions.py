"""Subscription presets (github-copilot, openai-codex) and the shipped openai preset: the Sol rule, the Copilot reviewer
pairs, the high-stakes models, the 200k compaction point, and that each preset applies with --dry-run and for real."""
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

PRESETS = ("github-copilot", "openai-codex", "openai")
ROLES = ("foreman", "session-foreman", "explorer", "builder", "reviewer")


def preset(name):
    return json.loads((ROOT / "config" / "presets" / (name + ".json")).read_text(encoding="utf-8"))


def run(argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = fc.main(argv)
    return rc, out.getvalue(), err.getvalue()


def role_models(prov):
    """Yield (role, model id, thinking) for every model a provider block maps, strong rungs included."""
    for role, spec in prov.get("roles", {}).items():
        if "model" not in spec:
            continue
        yield role, spec["model"], spec.get("thinking")
        if "strong" in spec:
            yield role + ".strong", spec["strong"]["model"], spec["strong"].get("thinking")


class SubscriptionPresetsTest(unittest.TestCase):
    def test_sol_only_reviews(self):
        for path in sorted((ROOT / "config" / "presets").glob("*.json")):
            name = path.stem
            for prov in preset(name).get("providers", {}).values():
                for role, model, _th in role_models(prov):
                    if role.split(".")[0] == "reviewer":
                        continue
                    self.assertNotIn("-sol", model, "%s %s %s" % (name, role, model))

    def test_models_belong_to_their_provider(self):
        for name in PRESETS:
            for prov_name, prov in preset(name)["providers"].items():
                for role, model, _th in role_models(prov):
                    self.assertTrue(model.startswith(prov_name + "/"), "%s %s %s" % (name, role, model))

    def test_openai_strong_rung_is_terra_and_order(self):
        prov = preset("openai")["providers"]["openai"]
        self.assertEqual(prov["roles"]["explorer"]["strong"]["model"], "openai/gpt-6.1-terra")
        self.assertEqual(prov["roles"]["builder"]["strong"]["model"], "openai/gpt-6.1-terra")
        self.assertEqual(prov["roles"]["reviewer"]["strong"]["model"], "openai/gpt-6.1-sol")
        tiers = {m["match"]: m["tier"] for m in prov["ranks"]}
        self.assertEqual(tiers, {"gpt-*-astra*": 0, "gpt-*-sol*": 2, "gpt-*-terra*": 3, "gpt-*-luna*": 4})

    def test_codex_map(self):
        prov = preset("openai-codex")["providers"]["openai-codex"]
        self.assertEqual(prov["roles"]["foreman"]["model"], "openai-codex/gpt-6-astra")
        self.assertEqual(prov["roles"]["explorer"]["model"], "openai-codex/gpt-6-luna")
        self.assertEqual(prov["roles"]["builder"]["strong"]["model"], "openai-codex/gpt-6.1-terra")
        self.assertEqual(prov["roles"]["reviewer"]["model"], "openai-codex/gpt-6.1-sol")
        self.assertEqual(preset("openai-codex")["ceremony"]["highStakes"]["model"], "openai-codex/gpt-6.2-astra:high")

    def test_copilot_map(self):
        data = preset("github-copilot")
        prov = data["providers"]["github-copilot"]
        self.assertEqual(prov["roles"]["foreman"]["model"], "github-copilot/claude-opus-5.5")
        self.assertEqual(prov["roles"]["session-foreman"]["model"], "github-copilot/claude-opus-5.5")
        self.assertEqual(prov["roles"]["explorer"]["thinking"], "low")
        self.assertEqual(prov["roles"]["explorer"]["strong"]["thinking"], "low")
        self.assertEqual(prov["roles"]["builder"]["strong"]["model"], "github-copilot/gpt-6.1-terra")
        self.assertEqual(prov["roles"]["reviewer"]["model"], "github-copilot/gpt-6.1-sol")
        self.assertEqual(data["compaction"], {"maxTokens": 200000})
        self.assertNotIn("cache", prov)
        self.assertNotIn("childMaxThinking", data)

    def test_copilot_reviewer_pairs_and_high_stakes(self):
        ceremony = preset("github-copilot")["ceremony"]
        pairs = ceremony["reviewModel"]
        self.assertEqual(pairs["github-copilot/claude-opus-5.5"], "github-copilot/gpt-6.1-sol:high")
        self.assertEqual(pairs["github-copilot/claude-sonnet-5.5"], "github-copilot/claude-opus-5.5:high")
        for key, value in pairs.items():
            self.assertNotEqual(key, value.split(":")[0])
        self.assertEqual(ceremony["highStakes"]["model"], "github-copilot/claude-fable-5.2:high")

    def test_claude_bridge_high_stakes(self):
        for name in ("claude-bridge", "claude-bridge-sonnet-reviewer"):
            self.assertEqual(preset(name)["ceremony"]["highStakes"]["model"], "claude-bridge/claude-fable-5-2:high", name)

    def test_dry_run_writes_nothing(self):
        for name in PRESETS:
            with tempfile.TemporaryDirectory() as tmp:
                rc, _out, err = run(["apply-preset", name, "--dry-run", "--agent-dir", tmp])
                self.assertEqual(rc, 0, err)
                self.assertEqual(list(Path(tmp).iterdir()), [], name)

    def test_foreman_flag_moves_only_the_foreman(self):
        with tempfile.TemporaryDirectory() as tmp:
            rc, out, err = run(["apply-preset", "github-copilot", "--foreman", "github-copilot/claude-sonnet-5.5", "--dry-run", "--agent-dir", tmp])
            self.assertEqual(rc, 0, err)
            cfg = json.loads(out)  # no rankTiers: the dry run prints the merged file
            roles = cfg["providers"]["github-copilot"]["roles"]
            self.assertEqual(roles["foreman"]["model"], "github-copilot/claude-sonnet-5.5")
            self.assertEqual(roles["session-foreman"]["model"], "github-copilot/claude-opus-5.5")
            self.assertEqual(cfg["ceremony"]["reviewModel"], preset("github-copilot")["ceremony"]["reviewModel"])
            self.assertEqual(cfg["ceremony"]["highStakes"], preset("github-copilot")["ceremony"]["highStakes"])

    def test_real_apply_loads_cleanly(self):
        for name in PRESETS:
            with tempfile.TemporaryDirectory() as tmp:
                rc, _out, err = run(["apply-preset", name, "--agent-dir", tmp])
                self.assertEqual(rc, 0, err)
                target = Path(tmp) / "foreman.json"
                self.assertTrue(target.is_file(), name)
                res = fc.load_config(agent_dir=tmp)
                self.assertEqual(res["errors"], [], name)
                self.assertTrue(res["config"]["providers"], name)


if __name__ == "__main__":
    unittest.main()
