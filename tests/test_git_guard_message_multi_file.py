"""R12 item 1c: a commit with several -F/--file options, or -F together with -m, is an unread message (git uses only the last -F;
the guard would lint the first): child deny, foreman ask. A single conforming -F in the worktree is unchanged. Command STRINGS only."""
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
NOT_READABLE = "message not readable, child cannot ask"


def decide(command, mode, cwd):
    d = gg.decide(command, mode, cwd=cwd)
    return LEVEL[d.level], d.reason


class MultiMessageFileTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp(prefix="pf-gg-multi-")
        self.addCleanup(shutil.rmtree, self.repo, True)
        subprocess.run(["git", "-C", self.repo, "init", "-q"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        Path(self.repo, "ok.txt").write_text("fix(r12): x\n")
        Path(self.repo, "other.txt").write_text("review(r10): x\n")

    def expect_unread(self, command, foreman=True):
        got, reason = decide(command, "child", self.repo)
        self.assertEqual(got, "deny", command)
        self.assertIn(NOT_READABLE, reason, command)
        if foreman:
            self.assertEqual(decide(command, "main", self.repo)[0], "ask", command)

    def test_two_message_files_unread(self):
        self.expect_unread("git commit -F ok.txt -F other.txt")
        self.expect_unread("git commit --file ok.txt --file=other.txt")
        self.expect_unread("git commit -Fok.txt -F other.txt")

    def test_message_file_then_stdin_heredoc_child_denied(self):
        self.expect_unread("git commit -F ok.txt -F - <<'EOF'\nreview(r10): x\nEOF")

    def test_message_file_with_m_unread(self):
        self.expect_unread("git commit -F ok.txt -m 'fix: x'")
        self.expect_unread("git commit -m 'fix: x' -F other.txt")

    def test_single_conforming_message_file_unchanged(self):
        self.assertEqual(decide("git commit -F ok.txt", "child", self.repo)[0], "allow")
        self.assertEqual(decide("git commit -F ok.txt", "main", self.repo)[0], "allow")


if __name__ == "__main__":
    unittest.main()
