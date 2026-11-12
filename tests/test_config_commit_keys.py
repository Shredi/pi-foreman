"""safety.git.commit.* is no longer used: no default, every layer accepts it without a warning or an error,
and the value passes through the merge unchanged."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402


class CommitKeysTest(unittest.TestCase):
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

    def commit_of(self, res):
        return res["config"]["safety"]["git"].get("commit")

    def test_defaults_carry_no_commit_keys(self):
        defaults = json.loads(fc.DEFAULTS_PATH.read_text(encoding="utf-8"))
        self.assertNotIn("commit", defaults["safety"]["git"])
        self.assertEqual(defaults["safety"]["git"]["protectedBranches"], ["main", "master"])
        self.assertIsNone(self.commit_of(self.load()))

    def test_project_layer_value_passes_through_silently(self):
        for pattern in ("^feat: ", "([unclosed"):
            commit = {"messagePattern": pattern, "requiredTrailers": ["^Co: "], "forbiddenTrailers": ["^X: "],
                      "checkCommand": ["true"]}
            res = self.load(proj={"safety": {"git": {"commit": commit}}})
            self.assertEqual(res["warnings"], [])
            self.assertEqual(res["errors"], [])
            self.assertEqual(self.commit_of(res), commit)

    def test_session_layer_value_passes_through_silently(self):
        for pattern in ("^fix: ", "(bad"):
            res = self.load(session={"safety": {"git": {"commit": {"messagePattern": pattern}}}})
            self.assertEqual(res["warnings"], [])
            self.assertEqual(res["errors"], [])
            self.assertEqual(self.commit_of(res), {"messagePattern": pattern})

    def test_user_layer_value_passes_through_and_project_adds_keys(self):
        res = self.load(l2={"safety": {"git": {"commit": {"messagePattern": "(bad"}}}},
                        proj={"safety": {"git": {"commit": {"requiredTrailers": ["^A: "]}}}})
        self.assertEqual(res["warnings"], [])
        self.assertEqual(res["errors"], [])
        self.assertEqual(self.commit_of(res), {"messagePattern": "(bad", "requiredTrailers": ["^A: "]})

    def test_protected_branches_still_union(self):
        res = self.load(proj={"safety": {"git": {"protectedBranches": ["release/*"]}}})
        self.assertEqual(res["config"]["safety"]["git"]["protectedBranches"], ["main", "master", "release/*"])


if __name__ == "__main__":
    unittest.main()
