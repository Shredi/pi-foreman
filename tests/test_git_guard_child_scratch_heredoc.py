"""ceremony-fixes-2 item 4: a child's cat/tee heredoc write is allowed when every target lies strictly inside its own scratch dir.

The scratch dir comes from the launch environment (FOREMAN_SCRATCH), never from the command text. The case table is
tests/fixtures/child-scratch-heredoc-cases.json, shared with extensions/core-adapter/test/child-scratch-heredoc.test.ts.
No existing guard rule looks at `ln`, so the symlink-planted-in-the-same-command row is denied by child_scratch_targets itself:
the exception stands down when the line plants a link."""
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import git_guard as gg  # noqa: E402

TABLE = json.loads((ROOT / "tests" / "fixtures" / "child-scratch-heredoc-cases.json").read_text("utf-8"))
LEVEL = {gg.ALLOW: "allow", gg.ASK: "ask", gg.DENY: "deny"}
WHY = "never heredoc or stdin-script file writes"


class ChildScratchHeredocTest(unittest.TestCase):
    def setUp(self):
        base = os.path.realpath(tempfile.mkdtemp(prefix="pf-gg-sh-"))
        self.addCleanup(shutil.rmtree, base, True)
        self.scratch = base + "/pi-foreman-scratch/sess/launch"
        self.ws = base + "/ws"
        os.makedirs(self.scratch)
        os.makedirs(self.ws)
        self.env = dict(os.environ, FOREMAN_SCRATCH=self.scratch)

    def sub(self, s):
        return s.replace("{scratch}", self.scratch).replace("{ws}", self.ws)

    def decide(self, line, mode="child"):
        d = gg.decide(line, mode, cwd=self.ws, env=self.env)
        return LEVEL[d.level], d.reason

    def test_table(self):
        for c in TABLE["shell"]:
            if c["guard"] is None:
                continue
            with self.subTest(case=c["name"]):
                got, reason = self.decide(self.sub(c["line"]))
                if c["guard"] == "deny":
                    self.assertEqual(got, "deny", reason)
                    self.assertIn(WHY, reason)
                else:
                    self.assertEqual((got, reason), ("allow", ""))

    def test_symlink_already_in_scratch_is_followed(self):
        os.symlink(self.ws + "/f", self.scratch + "/link")
        got, reason = self.decide("cat > $FOREMAN_SCRATCH/link <<EOF\nhi\nEOF")
        self.assertEqual(got, "deny", reason)
        self.assertIn(WHY, reason)

    def test_the_scratch_dir_comes_from_the_environment_only(self):
        self.env = {k: v for k, v in self.env.items() if k != "FOREMAN_SCRATCH"}
        got, reason = self.decide(self.sub("cat > {scratch}/n <<EOF\nhi\nEOF"))
        self.assertEqual(got, "deny")
        self.assertIn(WHY, reason)

    def test_main_mode_is_unchanged(self):
        got, reason = self.decide(self.sub("cat > {scratch}/n <<EOF\nhi\nEOF"), "main")
        self.assertNotIn(WHY, reason)


if __name__ == "__main__":
    unittest.main()
