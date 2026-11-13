"""sessions.blockedNoticeSeconds (the delay of the parent's blocked-child notice) comes from the user layer and the
overlay files (L3); the project and session layers are ignored with a warning. The layer rule lives in scripts/foreman_config.py, so the
test is here; the TypeScript side (childblocked.ts noticeSeconds) only reads the merged value."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402


class BlockedNoticeLayerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(os.path.realpath(self.tmp.name))
        self.agent = root / "agent"
        self.agent.mkdir()
        self.project = root / "proj"
        (self.project / ".pi").mkdir(parents=True)
        (self.project / ".git").mkdir()

    def load(self, proj=None, l2=None, session=None, l3=None):
        l3_paths = []
        if l3 is not None:
            (self.agent.parent / "l3.json").write_text(json.dumps(l3))
            l3_paths = [str(self.agent.parent / "l3.json")]
        if l2 is not None:
            (self.agent / "foreman.json").write_text(json.dumps(l2))
        if proj is not None:
            (self.project / ".pi" / "foreman.json").write_text(json.dumps(proj))
        return fc.load_config(agent_dir=str(self.agent), project_dir=str(self.project), trusted_project=True, l3_paths=l3_paths,
                              session_json=json.dumps(session) if session is not None else None)

    def seconds(self, res):
        return res["config"].get("sessions", {}).get("blockedNoticeSeconds")

    def test_user_layer_sets_it(self):
        res = self.load(l2={"sessions": {"blockedNoticeSeconds": 120}})
        self.assertEqual(self.seconds(res), 120)
        self.assertEqual(res["errors"], [])

    def test_zero_from_the_user_layer_is_kept(self):
        res = self.load(l2={"sessions": {"blockedNoticeSeconds": 0}})
        self.assertEqual(self.seconds(res), 0)

    def test_overlay_layer_sets_it(self):
        res = self.load(l3={"sessions": {"blockedNoticeSeconds": 30}})
        self.assertEqual(self.seconds(res), 30)
        self.assertEqual(res["errors"], [])

    def test_session_layer_is_ignored_like_the_project_layer(self):
        res = self.load(l2={"sessions": {"blockedNoticeSeconds": 120}}, session={"sessions": {"blockedNoticeSeconds": 30}})
        self.assertEqual(self.seconds(res), 120)
        self.assertIn("session sessions.blockedNoticeSeconds ignored", "\n".join(res["warnings"]))

    def test_project_layer_is_ignored_with_a_warning(self):
        res = self.load(l2={"sessions": {"blockedNoticeSeconds": 120}}, proj={"sessions": {"blockedNoticeSeconds": 86400}})
        self.assertEqual(self.seconds(res), 120)
        self.assertIn("blockedNoticeSeconds", "\n".join(res["warnings"]))

    def test_project_layer_alone_leaves_it_unset(self):
        res = self.load(proj={"sessions": {"blockedNoticeSeconds": 0}})
        self.assertIsNone(self.seconds(res))


if __name__ == "__main__":
    unittest.main()
