"""R12 item 1, parent ruling 3 (whitelist shape). F1: a child's stdin commit message (`-F -`, `-F /dev/stdin`, `--file=-`) is linted only
when the commit carries exactly one redirection token, a plain `<<` / `<<-` heredoc with no fd number, no pipe into it, no group around
it, and no earlier segment of the line has `exec`, a redirection or a group; anything else is a deny for a child. F2: a child's
`-F <file>` is denied when the line writes, appends, copies, moves, links onto or exec-opens that path (the guard reads the file before
the line runs). The foreman keeps the ask. Command STRINGS only."""
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

DUP_FD0 = "git commit -F - <<'EOF' 0>&3\nfix(r12): conforming\nEOF"
GROUP_FD3 = "{ git commit -F - <<'EOF'\nfix(r12): conforming\nEOF\n} 3<msg.txt"
EXEC_EARLIER = "exec 3<msg.txt\ngit commit -F - <<'EOF'\nfix(r12): conforming\nEOF"
PLAIN_OK = "git commit -F - <<'EOF'\nfix(r12): conforming\nEOF"
DASH_OK = "git commit -F - <<-EOF\n\tfix(r12): conforming\n\tEOF"
PLAIN_BAD = "git commit -F - <<'EOF'\nbad subject\nEOF"
WRITE_THEN_F = "printf 'x\\n' > ok.txt && git commit -F ok.txt"
CP_THEN_F = "cp other.txt ok.txt && git commit -F ok.txt"
MV_THEN_F = "mv other.txt ok.txt && git commit -F ok.txt"
LN_THEN_F = "ln -sf other.txt ok.txt && git commit -F ok.txt"
TEE_THEN_F = "printf 'x\\n' | tee ok.txt && git commit -F ok.txt"
APPEND_EARLIER_LINE = "printf 'x\\n' >> ok.txt\ngit commit -F ok.txt"
EXEC_OPEN_F = "exec 3>ok.txt\ngit commit -F ok.txt"
CP_INTO_DIR = "cp /elsewhere/msg.txt .workflow/scratch/ && git commit -F .workflow/scratch/msg.txt"
ADD_THEN_SCRATCH = "git add -A && git commit -F .workflow/scratch/msg.txt"

STDIN_DENY = (DUP_FD0, GROUP_FD3, EXEC_EARLIER)
FILE_DENY = (WRITE_THEN_F, CP_THEN_F, MV_THEN_F, LN_THEN_F, TEE_THEN_F, APPEND_EARLIER_LINE, EXEC_OPEN_F, CP_INTO_DIR)


def decide(command, mode, cwd):
    d = gg.decide(command, mode, cwd=cwd)
    return LEVEL[d.level], d.reason


class MessageWhitelistTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp(prefix="pf-gg-wl-")
        self.addCleanup(shutil.rmtree, self.repo, True)
        subprocess.run(["git", "-C", self.repo, "init", "-q"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        Path(self.repo, "msg.txt").write_text("bad subject\n")
        # ok.txt conforms today: a deny below comes from the same-line write, not from the file's current text
        Path(self.repo, "ok.txt").write_text("fix(r12): conforming\n")
        Path(self.repo, "other.txt").write_text("bad subject\n")
        scratch = Path(self.repo, ".workflow", "scratch")
        scratch.mkdir(parents=True)
        (scratch / "msg.txt").write_text("fix(r12): conforming\n")

    def assert_child_deny(self, command):
        got, reason = decide(command, "child", self.repo)
        self.assertEqual(got, "deny", (command, reason))
        self.assertIn("child cannot ask", reason, command)

    # ---------------------------------------------------------------- lexer
    def test_lexer_records_write_dup_redirect_with_fd(self):
        seg = gg.lex(DUP_FD0, "bash").segs[0]
        self.assertEqual([(fd, op, w.text) for fd, op, w in seg.redirs], [(None, "<<", "EOF"), (0, ">&", "3")])
        seg = gg.lex("exec 3<msg.txt", "bash").segs[0]
        self.assertEqual([(fd, op, w.text) for fd, op, w in seg.redirs], [(3, "<", "msg.txt")])

    # ---------------------------------------------------------------- F1: stdin whitelist
    def test_child_heredoc_with_fd0_dup_denied(self):
        self.assert_child_deny(DUP_FD0)

    def test_child_heredoc_in_group_with_fd3_denied(self):
        self.assert_child_deny(GROUP_FD3)

    def test_child_exec_earlier_line_then_heredoc_denied(self):
        self.assert_child_deny(EXEC_EARLIER)

    def test_child_plain_heredoc_conforming_passes(self):
        got, reason = decide(PLAIN_OK, "child", self.repo)
        self.assertEqual(got, "allow", reason)

    def test_child_dash_heredoc_conforming_passes(self):
        got, reason = decide(DASH_OK, "child", self.repo)
        self.assertEqual(got, "allow", reason)

    def test_child_plain_heredoc_non_conforming_denied(self):
        got, reason = decide(PLAIN_BAD, "child", self.repo)
        self.assertEqual(got, "deny", reason)
        self.assertIn("safety.git.commit.messagePattern", reason)

    # ---------------------------------------------------------------- F2: same-line write to the -F file
    def test_child_printf_redirect_then_message_file_denied(self):
        self.assert_child_deny(WRITE_THEN_F)

    def test_child_cp_mv_ln_tee_then_message_file_denied(self):
        for c in (CP_THEN_F, MV_THEN_F, LN_THEN_F, TEE_THEN_F):
            self.assert_child_deny(c)

    def test_child_append_earlier_line_exec_open_copy_into_dir_denied(self):
        for c in (APPEND_EARLIER_LINE, EXEC_OPEN_F, CP_INTO_DIR):
            self.assert_child_deny(c)

    def test_child_add_then_scratch_message_file_passes(self):
        got, reason = decide(ADD_THEN_SCRATCH, "child", self.repo)
        self.assertEqual(got, "allow", reason)

    # ---------------------------------------------------------------- foreman keeps the ask
    def test_foreman_forms_of_deny_lines_ask(self):
        for c in STDIN_DENY + FILE_DENY:
            self.assertEqual(decide(c, "main", self.repo)[0], "ask", c)


if __name__ == "__main__":
    unittest.main()
