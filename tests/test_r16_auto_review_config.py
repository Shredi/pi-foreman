"""R16 item 1/2 for the gate world: the auto-review (the gate's review step) is configured by gate.* and providers.*.roles.review,
user layer only (project and session cannot loosen it); the old safety.permissions.autoReview key is gone (unknown key)."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402


class AutoReviewConfigTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(os.path.realpath(self.tmp.name))
        self.agent = root / "agent"
        self.agent.mkdir()
        self.project = root / "proj"
        (self.project / ".pi").mkdir(parents=True)
        (self.project / ".git").mkdir()

    def load(self, l2=None, proj=None, session=None):
        if l2 is not None:
            (self.agent / "foreman.json").write_text(json.dumps(l2))
        if proj is not None:
            (self.project / ".pi" / "foreman.json").write_text(json.dumps(proj))
        return fc.load_config(agent_dir=str(self.agent), project_dir=str(self.project), trusted_project=True,
                              session_json=json.dumps(session) if session is not None else None, l3_paths=[])

    def test_default_review_is_on_with_the_shipped_policy(self):
        gate = self.load()["config"]["gate"]
        self.assertEqual(gate["reviewTimeoutMs"], 15000)
        self.assertIsNone(gate.get("policy", {}).get("userFile"))

    def test_user_layer_sets_policy_file_and_review_model(self):
        res = self.load(l2={"gate": {"policy": {"userFile": "~/my-rules.md"}, "reviewTimeoutMs": 20000},
                            "providers": {"p": {"roles": {"review": {"model": "m"}}}}})
        cfg = res["config"]
        self.assertEqual(cfg["gate"]["policy"]["userFile"], "~/my-rules.md")
        self.assertEqual(cfg["gate"]["reviewTimeoutMs"], 20000)
        self.assertEqual(cfg["providers"]["p"]["roles"]["review"]["model"], "m")

    def test_project_and_session_cannot_set_the_policy_file_or_review_model(self):
        l2 = {"gate": {"policy": {"userFile": "mine.md"}}, "providers": {"p": {"roles": {"review": {"model": "good"}}}}}
        bad = {"gate": {"policy": {"userFile": "/tmp/evil.md"}}, "providers": {"p": {"roles": {"review": {"model": "weak"}}}}}
        for kw in ({"proj": bad}, {"session": bad}):
            res = self.load(l2=l2, **kw)
            cfg = res["config"]
            self.assertEqual(cfg["gate"]["policy"]["userFile"], "mine.md", kw)
            self.assertEqual(cfg["providers"]["p"]["roles"]["review"]["model"], "good", kw)
            self.assertTrue(any("ignored" in w for w in res["warnings"]), res["warnings"])

    def test_old_auto_review_key_is_an_unknown_key(self):
        res = self.load(l2={"safety": {"permissions": {"autoReview": {"enabled": False, "rulesFile": "~/my-rules.md"}}}})
        self.assertTrue(any("unknown key safety.permissions" in m for m in res["warnings"] + res["errors"]),
                        (res["warnings"], res["errors"]))


if __name__ == "__main__":
    unittest.main()
