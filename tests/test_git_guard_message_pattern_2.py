"""R11 fix round 1, item 8: a cd in a subshell or pipeline does not move the directory a later -F path is read from, and a
child commit whose message the guard cannot read is refused. Command STRINGS only."""
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


class MessageFileCdScopeTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp(prefix="pf-gg-mp2-")
        self.addCleanup(shutil.rmtree, self.repo, True)
        subprocess.run(["git", "-C", self.repo, "init", "-q"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        Path(self.repo, "sub").mkdir()
        # the file in sub/ passes the pattern, the one at the top does not: reading the wrong one shows
        Path(self.repo, "msg.txt").write_text("review(r10): x\n")
        Path(self.repo, "sub", "msg.txt").write_text("fix(r11): x\n")

    def expect_unsure(self, command):
        self.assertEqual(decide(command, "main", self.repo)[0], "ask", command)
        got, reason = decide(command, "child", self.repo)
        self.assertEqual(got, "deny", command)
        self.assertIn("-F <file inside the worktree>", reason)

    def test_message_file_subshell_cd_not_tracked(self):
        for c in ("(cd sub) && git commit -F msg.txt", "(cd sub && true); git commit -F msg.txt", "{ cd sub; } && git commit -F msg.txt",
                  "x=$(cd sub) && git commit -F msg.txt", "bash -c 'cd sub' && git commit -F msg.txt"):
            self.expect_unsure(c)
        # an absolute -F path does not depend on the directory
        c = "(cd sub) && git commit -F '%s/sub/msg.txt'" % self.repo
        for mode in ("main", "child"):
            self.assertEqual(decide(c, mode, self.repo)[0], "allow", mode)

    def test_message_file_pipeline_cd_not_tracked(self):
        for c in ("cd sub | true; git commit -F msg.txt", "true | cd sub && git commit -F msg.txt", "cd sub || true; git commit -F msg.txt",
                  "false || cd sub && git commit -F msg.txt", "cd $D && git commit -F msg.txt"):
            self.expect_unsure(c)

    def test_message_file_top_level_cd_tracked(self):
        for mode in ("main", "child"):
            for c in ("cd sub && git commit -F msg.txt", "cd sub; git commit -F msg.txt", "cd sub\ngit commit -F msg.txt"):
                self.assertEqual(decide(c, mode, self.repo)[0], "allow", (mode, c))
            self.assertEqual(decide("git commit -F msg.txt", mode, self.repo)[0], "deny", mode)
            self.assertEqual(decide("cd sub && cd .. && git commit -F msg.txt", mode, self.repo)[0], "deny", mode)


class ChildUnreadableMessageTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp(prefix="pf-gg-mp2c-")
        self.addCleanup(shutil.rmtree, self.repo, True)
        subprocess.run(["git", "-C", self.repo, "init", "-q"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def test_message_pattern_child_unreadable_message_denied(self):
        outside = tempfile.mkdtemp(prefix="pf-gg-mp2-out-")
        self.addCleanup(shutil.rmtree, outside, True)
        Path(outside, "msg.txt").write_text("fix(r11): x\n")
        for c in ('git commit -m "$(cat msg.txt)"', 'git commit -m "$MSG"', "git commit -m `cat msg.txt`", 'git commit -F "$F"',
                  "git commit -F '%s/msg.txt'" % outside, "git commit -F missing.txt"):
            got, reason = decide(c, "child", self.repo)
            self.assertEqual(got, "deny", c)
            self.assertIn("-m '<literal message>'", reason, c)
            self.assertIn("-F <file inside the worktree>", reason, c)
            self.assertIn("safety.git.commit.messagePattern", reason, c)
            # the foreman still gets the dialog
            self.assertEqual(decide(c, "main", self.repo)[0], "ask", c)
        # parent ruling: editor, --amend reuse and a -F - heredoc stay as they were for a child
        for c in ("git commit", "git commit --amend --no-edit", "git commit -F - <<'EOF'\nfeat: y\nEOF"):
            self.assertEqual(decide(c, "child", self.repo)[0], "allow", c)


if __name__ == "__main__":
    unittest.main()
