"""R10 cases, rewritten to the R12 item 1 behaviour: the messagePattern lints child commits too, and a -F file after a top-level cd
is read."""
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import git_guard as gg  # noqa: E402


class R10CurrentStateTest(unittest.TestCase):
    """R10 cases, rewritten to the R12 item 1 behaviour."""

    def setUp(self):
        self.repo = tempfile.mkdtemp(prefix="pf-gg-r10-")
        self.addCleanup(shutil.rmtree, self.repo, True)
        subprocess.run(["git", "-C", self.repo, "init", "-q"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        scratch = Path(self.repo, ".workflow", "scratch")
        scratch.mkdir(parents=True)
        (scratch / "msg.txt").write_text("review(r10): x\n")
        self.other = tempfile.mkdtemp(prefix="pf-gg-r10-cwd-")
        self.addCleanup(shutil.rmtree, self.other, True)

    def test_r10_child_commit_subject_not_linted_current_state(self):
        """R12: a child commit with a non-conventional subject is refused by the messagePattern (name kept from R10)."""
        d = gg.decide('git commit -m "review(r10): x"', "child", cwd=self.repo, config=None)
        self.assertEqual(d.level, gg.DENY)
        self.assertIn("messagePattern", d.reason or "")
        d = gg.decide('git commit -m "not conventional at all"', "child", cwd=self.repo, config=None)
        self.assertEqual(d.level, gg.DENY)
        self.assertIn("messagePattern", d.reason or "")

    def test_r10_message_file_after_cd_asks_current_state(self):
        """R12: main mode, cd <worktree> && git commit -F <relative file> from another cwd reads the file; the pattern decides."""
        d = gg.decide("cd %s && git commit -F .workflow/scratch/msg.txt" % self.repo, "main", cwd=self.other, config=None)
        self.assertEqual(d.level, gg.DENY)
        self.assertNotIn("cannot read the message file", d.reason)
        self.assertIn("messagePattern", d.reason)


if __name__ == "__main__":
    unittest.main()
