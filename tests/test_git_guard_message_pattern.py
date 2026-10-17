"""R11 item 8: safety.git.commit.messagePattern applies to foreman (main) and child commits alike,
and a -F message file in the worktree's .workflow/scratch/ is read. Command STRINGS only."""
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import git_guard as gg  # noqa: E402

LEVEL = {gg.ALLOW: "allow", gg.ASK: "ask", gg.DENY: "deny"}


def decide(command, mode, cwd):
    d = gg.decide(command, mode, cwd=cwd)
    return LEVEL[d.level], d.reason


class MessagePatternScopeTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp(prefix="pf-gg-mp-")
        self.addCleanup(shutil.rmtree, self.repo, True)
        subprocess.run(["git", "-C", self.repo, "init", "-q"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.scratch = Path(self.repo, ".workflow", "scratch")
        self.scratch.mkdir(parents=True)

    def test_message_pattern_child_nonconventional_subject_refused(self):
        got, _ = decide("git commit -m 'review(r10): x'", "child", self.repo)
        self.assertEqual(got, "deny")

    def test_message_pattern_foreman_nonconventional_subject_refused(self):
        for subject in ("review(r10): x", "r10: x"):
            got, _ = decide("git commit -m '%s'" % subject, "main", self.repo)
            self.assertEqual(got, "deny", subject)

    def test_message_pattern_scoped_fix_subject_passes_foreman_and_child(self):
        for mode in ("main", "child"):
            self.assertEqual(decide("git commit -m 'fix(r11): x'", mode, self.repo)[0], "allow", mode)

    def test_message_pattern_refusal_quotes_pattern(self):
        for mode in ("main", "child"):
            got, reason = decide("git commit -m 'review(r10): x'", mode, self.repo)
            self.assertEqual(got, "deny")
            self.assertIn(gg.DEFAULT_MESSAGE_PATTERN, reason)

    def test_message_file_in_worktree_scratch_read(self):
        (self.scratch / "msg.txt").write_text("fix(r11): x\n")
        (self.scratch / "bad.txt").write_text("review(r10): x\n")
        for mode in ("main", "child"):
            # relative to the worktree (cwd) and after a cd into it from elsewhere
            self.assertEqual(decide("git commit -F .workflow/scratch/msg.txt", mode, self.repo)[0], "allow", mode)
            self.assertEqual(decide("git commit -F .workflow/scratch/bad.txt", mode, self.repo)[0], "deny", mode)
        elsewhere = tempfile.mkdtemp(prefix="pf-gg-mp-else-")
        self.addCleanup(shutil.rmtree, elsewhere, True)
        self.assertEqual(decide("cd '%s' && git commit -F .workflow/scratch/msg.txt" % self.repo, "main", elsewhere)[0], "allow")
        self.assertEqual(decide("git -C '%s' commit -F .workflow/scratch/bad.txt" % self.repo, "main", elsewhere)[0], "deny")

    def test_message_file_outside_worktree_not_read(self):
        outside = tempfile.mkdtemp(prefix="pf-gg-mp-out-")
        self.addCleanup(shutil.rmtree, outside, True)
        Path(outside, "msg.txt").write_text("fix(r11): x\n")
        got, reason = decide("git commit -F '%s/msg.txt'" % outside, "main", self.repo)
        self.assertEqual(got, "ask")
        self.assertIn("cannot read the message file", reason)
        # a child cannot ask: a message file outside the worktree is refused (R11 fix round 1, item 8b)
        Path(outside, "bad.txt").write_text("review(r10): x\n")
        self.assertEqual(decide("git commit -F '%s/bad.txt'" % outside, "child", self.repo)[0], "deny")


if __name__ == "__main__":
    unittest.main()
