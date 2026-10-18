"""R11 fix round 1, item 8: a cd in a subshell or pipeline does not move the directory a later -F path is read from, and a
child commit whose message the guard cannot read is refused. Command STRINGS only."""
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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
        self.assertIn("-F <file in $FOREMAN_SCRATCH or <worktree>/.workflow/scratch/>", reason)

    def test_message_file_subshell_cd_not_tracked(self):
        for c in ("(cd sub) && git commit -F msg.txt", "(cd sub && true); git commit -F msg.txt", "{ cd sub; } && git commit -F msg.txt",
                  "x=$(cd sub) && git commit -F msg.txt", "bash -c 'cd sub' && git commit -F msg.txt"):
            self.expect_unsure(c)
        # an absolute -F path does not depend on the directory
        c = "(cd sub) && git commit -F '%s/sub/msg.txt'" % self.repo
        self.assertEqual(decide(c, "main", self.repo)[0], "allow")
        # r13 item 2: child -F allowlist forbids groups
        self.assertEqual(decide(c, "child", self.repo)[0], "deny")

    def test_message_file_pipeline_cd_not_tracked(self):
        for c in ("cd sub | true; git commit -F msg.txt", "true | cd sub && git commit -F msg.txt", "cd sub || true; git commit -F msg.txt",
                  "false || cd sub && git commit -F msg.txt", "cd $D && git commit -F msg.txt",
                  # R12 item 1: a cd after `&&` may not run, with `;` or a newline before the commit
                  "false && cd sub; git commit -F msg.txt", "false && cd sub\ngit commit -F msg.txt"):
            self.expect_unsure(c)

    def test_message_file_top_level_cd_tracked(self):
        for mode in ("main", "child"):
            for c in ("cd sub && git commit -F msg.txt", "cd sub; git commit -F msg.txt", "cd sub\ngit commit -F msg.txt"):
                # R14 item 2 (ruling 2b): a child's message file outside <worktree>/.workflow/scratch/ is refused (sub/ is not one)
                self.assertEqual(decide(c, mode, self.repo)[0], "allow" if mode == "main" else "deny", (mode, c))
            self.assertEqual(decide("git commit -F msg.txt", mode, self.repo)[0], "deny", mode)
        # R12 item 1: the second cd follows `&&` (not top-level), so the directory is unknown: foreman ask, child deny
        self.expect_unsure("cd sub && cd .. && git commit -F msg.txt")

    def test_untracked_cd_makes_message_cwd_unknown(self):
        # a non-top-level or computed cd before the commit leaves the cwd unknown, even when a later cd is top-level
        for c in ("false && cd sub; git commit -F msg.txt", "true && cd sub && git commit -F msg.txt", "cd $D; git commit -F msg.txt",
                  "cd \"$D\"\ngit commit -F msg.txt", "(cd sub); cd sub; git commit -F msg.txt", "cd sub | true\ncd sub; git commit -F msg.txt",
                  "cd sub & git commit -F msg.txt"):
            self.expect_unsure(c)
        # message text that names a cd is never read as one: the -m text and the -F file text do not move the directory
        Path(self.repo, "cdmsg.txt").write_text("fix(r11): x; cd sub\n")
        for mode in ("main", "child"):
            self.assertEqual(decide("git commit -m 'fix(r11): x; cd sub' && git commit -F msg.txt", mode, self.repo)[0], "deny", mode)
            self.assertEqual(decide("git commit -F cdmsg.txt && git commit -F msg.txt", mode, self.repo)[0], "deny", mode)

    def test_message_file_in_worktree_scratch_read_foreman_and_child(self):
        scratch = Path(self.repo, ".workflow", "scratch")
        scratch.mkdir(parents=True)
        (scratch / "ok.txt").write_text("fix(r11): x\n")
        (scratch / "bad.txt").write_text("review(r10): x\n")
        elsewhere = tempfile.mkdtemp(prefix="pf-gg-mp2-else-")
        self.addCleanup(shutil.rmtree, elsewhere, True)
        for mode in ("main", "child"):
            for prefix, cwd in (("", self.repo), ("cd '%s' && " % self.repo, elsewhere), ("cd '%s'; " % self.repo, elsewhere),
                                ("cd '%s'\n" % self.repo, elsewhere)):
                got, reason = decide(prefix + "git commit -F .workflow/scratch/ok.txt", mode, cwd)
                self.assertEqual(got, "allow", (mode, prefix))
                got, reason = decide(prefix + "git commit -F .workflow/scratch/bad.txt", mode, cwd)
                self.assertEqual(got, "deny", (mode, prefix))
                self.assertIn("safety.git.commit.messagePattern", reason)
                self.assertNotIn("cannot read the message file", reason)
                self.assertNotIn("review(r10)", reason)  # a -F file's text never goes into a deny reason

    def test_r10_literal_subject(self):
        # R12 item 1 (parent ruling): the R10 subjects get the SAME verdict from the same pattern in both modes, -m and -F read
        scratch = Path(self.repo, ".workflow", "scratch")
        scratch.mkdir(parents=True)
        verdicts = set()
        for i, subject in enumerate(("review(r10): x", "overlay(r10): x", "r10: x")):
            (scratch / ("r10-%d.txt" % i)).write_text(subject + "\n")
            for mode in ("main", "child"):
                for c in ("git commit -m '%s'" % subject, "git commit -F .workflow/scratch/r10-%d.txt" % i,
                          "cd '%s' && git commit -F .workflow/scratch/r10-%d.txt" % (self.repo, i)):
                    got, reason = decide(c, mode, self.repo)
                    self.assertIn("safety.git.commit.messagePattern %s" % gg.DEFAULT_MESSAGE_PATTERN, reason, (mode, c))
                    verdicts.add(got)
        self.assertEqual(verdicts, {"deny"})


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
            self.assertIn("-F <file in $FOREMAN_SCRATCH or <worktree>/.workflow/scratch/>", reason, c)
            self.assertIn("safety.git.commit.messagePattern", reason, c)
            # the foreman still gets the dialog
            self.assertEqual(decide(c, "main", self.repo)[0], "ask", c)
        # R12 item 1 child-stdin ruling: an unsure message (editor, --amend reuse) is a deny for a child; a literal -F - heredoc is linted
        for c in ("git commit", "git commit --amend --no-edit"):
            self.assertEqual(decide(c, "child", self.repo)[0], "deny", c)
        self.assertEqual(decide("git commit -F - <<'EOF'\nfeat: y\nEOF", "child", self.repo)[0], "allow")

    def test_message_file_commonpath_value_error_is_unsure(self):
        # R12 item 1: os.path.commonpath raises ValueError across Windows drives; that is outside the worktree, so unsure
        Path(self.repo, "msg.txt").write_text("fix(r11): x\n")
        with mock.patch.object(gg.os.path, "commonpath", side_effect=ValueError("Paths don't have the same drive")):
            got, reason = decide("git commit -F msg.txt", "child", self.repo)
            self.assertEqual(got, "deny")
            self.assertIn("cannot read the message file msg.txt", reason)
            self.assertEqual(decide("git commit -F msg.txt", "main", self.repo)[0], "ask")


if __name__ == "__main__":
    unittest.main()
