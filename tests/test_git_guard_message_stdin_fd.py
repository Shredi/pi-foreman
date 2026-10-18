"""R12 item 1, reviewer finding (parent ruling): the lexer keeps the fd of an input redirect, so a heredoc on fd 3 is not taken
for the stdin message of `git commit -F -`. For a child, `-F -` / `-F /dev/stdin` with a pipe, an input redirect on an explicit
fd other than 0, or several stdin sources is a deny; only a literal heredoc on fd 0 is linted. The foreman keeps the ask.
A computed --trailer is a deny for a child with its own wording. Command STRINGS only."""
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

PIPE_FD3 = "printf 'bad subject\\n' | git commit -F - 3<<'EOF'\nfix(r12): conforming body\nEOF"
FILE_FD3 = "git commit -F - <msg.txt 3<<'EOF'\nfix(r12): conforming body\nEOF"
HEREDOC_OK = "git commit -F - <<'EOF'\nfix(r12): conforming\nEOF"
HEREDOC_BAD = "git commit -F - <<'EOF'\nbad subject\nEOF"
TRAILER_COMPUTED = "git commit -m 'fix(r12): x' --trailer \"Refs: $X\""


def decide(command, mode, cwd):
    d = gg.decide(command, mode, cwd=cwd)
    return LEVEL[d.level], d.reason


class StdinFdTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp(prefix="pf-gg-stdinfd-")
        self.addCleanup(shutil.rmtree, self.repo, True)
        subprocess.run(["git", "-C", self.repo, "init", "-q"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        Path(self.repo, "msg.txt").write_text("bad subject\n")

    def test_lexer_keeps_redirect_fd(self):
        seg = gg.lex(FILE_FD3, "bash").segs[0]
        self.assertEqual(seg.ins, [(0, "<", None), (3, "<<'", "fix(r12): conforming body")])

    def test_child_pipe_with_fd3_heredoc_denied(self):
        got, reason = decide(PIPE_FD3, "child", self.repo)
        self.assertEqual(got, "deny", reason)

    def test_child_file_redirect_with_fd3_heredoc_denied(self):
        got, reason = decide(FILE_FD3, "child", self.repo)
        self.assertEqual(got, "deny", reason)

    def test_child_fd0_heredoc_conforming_passes(self):
        got, reason = decide(HEREDOC_OK, "child", self.repo)
        self.assertEqual(got, "allow", reason)

    def test_child_fd0_heredoc_non_conforming_denied(self):
        got, reason = decide(HEREDOC_BAD, "child", self.repo)
        self.assertEqual(got, "deny", reason)
        self.assertIn("safety.git.commit.messagePattern", reason)

    def test_main_bypass_forms_ask(self):
        for c in (PIPE_FD3, FILE_FD3):
            self.assertEqual(decide(c, "main", self.repo)[0], "ask", c)

    def test_child_computed_trailer_denied_with_own_wording(self):
        got, reason = decide(TRAILER_COMPUTED, "child", self.repo)
        self.assertEqual(got, "deny", reason)
        self.assertIn("computed trailer, child cannot ask", reason)
        self.assertNotIn("message not readable", reason)
        self.assertEqual(decide(TRAILER_COMPUTED, "main", self.repo)[0], "ask")


if __name__ == "__main__":
    unittest.main()
