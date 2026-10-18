"""R12 item 1, child-stdin addendum (parent ruling): for a child an unsure commit message is a deny, never the child_rules allow.
`git commit -F -` / `-F /dev/stdin` with a literal heredoc on the commit is linted on the heredoc body (subject = first non-empty line);
any other stdin or computed message source is denied for a child; the foreman keeps the ask. Command STRINGS only."""
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


class ChildStdinMessageTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp(prefix="pf-gg-stdin-")
        self.addCleanup(shutil.rmtree, self.repo, True)
        subprocess.run(["git", "-C", self.repo, "init", "-q"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        Path(self.repo, "msg.txt").write_text("fix(r12): x\n")

    def test_child_heredoc_message_non_matching_subject_denied(self):
        for c in ("git commit -F - <<EOF\nreview(r10): x\nEOF", "git commit -F - <<'EOF'\n\nreview(r10): x\n\nbody\nEOF",
                  "git commit -F /dev/stdin <<'EOF'\nreview(r10): x\nEOF", "git commit -F- <<-EOF\n\treview(r10): x\n\tEOF"):
            got, reason = decide(c, "child", self.repo)
            self.assertEqual(got, "deny", c)
            self.assertIn("safety.git.commit.messagePattern", reason, c)
            self.assertIn("review(r10)", reason, c)
            self.assertEqual(decide(c, "main", self.repo)[0], "ask", c)

    def test_child_heredoc_message_matching_subject_passes(self):
        for c in ("git commit -F - <<EOF\nfix(r12): x\nEOF", "git commit -F - <<'EOF'\n\nfeat: y\n\nbody with $HOME\nEOF",
                  "git commit -F /dev/stdin <<\"EOF\"\nfix: z\nEOF", "git commit -q -F - <<'EOF' && git log -1\nfix: z\nEOF"):
            self.assertEqual(decide(c, "child", self.repo)[0], "allow", c)
            self.assertEqual(decide(c, "main", self.repo)[0], "ask", c)

    def test_child_stdin_from_file_or_pipe_denied(self):
        for c in ("git commit -F - < msg.txt", "git commit -F /dev/stdin < msg.txt", "cat msg.txt | git commit -F -",
                  "git commit -F - <<< 'fix: x'", "git commit -F -", "git commit -F - <<EOF < msg.txt\nfix: x\nEOF",
                  # an unquoted heredoc that expands is computed
                  "git commit -F - <<EOF\n$(cat msg.txt)\nEOF", "git commit -F - <<EOF\nfix: $X\nEOF"):
            got, reason = decide(c, "child", self.repo)
            self.assertEqual(got, "deny", c)
            self.assertIn(NOT_READABLE, reason, c)
            self.assertEqual(decide(c, "main", self.repo)[0], "ask", c)

    def test_child_other_unsure_message_denied_not_child_rules_allow(self):
        # editor, --amend reuse, -C reuse and computed arguments: the foreman asks, a child is denied
        for c in ("git commit", "git commit --amend --no-edit", "git commit -C HEAD", "git commit $ARGS"):
            got, reason = decide(c, "child", self.repo)
            self.assertEqual(got, "deny", c)
            self.assertIn(NOT_READABLE, reason, c)
            self.assertEqual(decide(c, "main", self.repo)[0], "ask", c)


if __name__ == "__main__":
    unittest.main()
