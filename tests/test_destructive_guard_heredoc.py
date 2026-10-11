"""destructive_guard.py: heredoc bodies are stdin prose, not commands (harness-friction row 13)."""
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "core" / "scripts"))
import destructive_guard as dg  # noqa: E402


class HeredocTest(unittest.TestCase):
    def verdict(self, command):
        return dg._check_command(command, tempfile.gettempdir())

    def test_prose_in_a_heredoc_body_is_not_a_command(self):
        for body in ("notes: the .pi dir and $x are prose", "rm -rf $x", "rm -rf /", "> $x"):
            for open_ in ("cat <<'EOT'", 'cat <<"EOT"', "cat <<EOT", "cat > docs/n.md <<'EOT'", "cat <<-EOT"):
                with self.subTest(body=body, open=open_):
                    self.assertIsNone(self.verdict("%s\n%s\nEOT" % (open_, body)))

    def test_the_command_after_the_terminator_is_still_checked(self):
        v = self.verdict("cat <<'EOT'\nprose\nEOT\nrm -rf $x")
        self.assertEqual(v[0], "deny")

    def test_the_command_on_the_heredoc_line_is_still_checked(self):
        self.assertEqual(self.verdict("rm -rf $x; cat <<'EOT'\nprose\nEOT")[0], "deny")
        self.assertEqual(self.verdict("cat <<'EOT' && rm -rf $x\nprose\nEOT")[0], "deny")

    def test_here_string_and_plain_rm_are_unchanged(self):
        self.assertEqual(self.verdict("rm -rf $x")[0], "deny")
        self.assertEqual(self.verdict("cat <<< 'x'\nrm -rf $x")[0], "deny")

    def test_unterminated_heredoc_hides_nothing_before_it(self):
        self.assertEqual(self.verdict("rm -rf $x\ncat <<'EOT'\nprose")[0], "deny")


if __name__ == "__main__":
    unittest.main()
