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

    def test_a_heredoc_fed_to_a_shell_is_executed_text(self):
        for open_ in ("bash <<'EOF'", "sh <<EOF", "bash -s <<'EOF'", "cat <<EOF | bash", "cat <<'EOF' | sh -s",
                      "cat <<EOF | xargs rm", "python3 - <<'EOF'", "cat <<EOF |& bash", "FOO=1 bash <<EOF"):
            with self.subTest(open=open_):
                self.assertEqual(self.verdict('%s\nrm -rf "$x"/*\nEOF' % open_)[0], "deny")

    def test_a_reader_pipeline_keeps_the_prose_skip(self):
        for open_ in ("cat <<'EOF' | grep x", "cat <<EOF | tee out.txt | head", "grep -c x <<'EOF'", "sort <<EOF"):
            with self.subTest(open=open_):
                self.assertIsNone(self.verdict('%s\nrm -rf "$x"/*\nEOF' % open_))

    def test_arithmetic_shift_is_not_a_heredoc(self):
        for cmd in ('echo $((1<<2))\nrm -rf "$x"/*', 'x=$((1 << EOF))\nrm -rf "$x"/*', '((y=1<<2))\nrm -rf "$x"/*'):
            with self.subTest(cmd=cmd):
                self.assertEqual(self.verdict(cmd)[0], "deny")

    def test_process_substitution_and_later_executors_keep_the_body_scanned(self):
        for cmd in ('cat <<A > >(bash)\nrm -rf "$x"/*\nA',
                    'cat <<A | tee >(sh)\nrm -rf "$x"/*\nA',
                    'tee <<A x.sh; bash x.sh\nrm -rf "$x"/*\nA',
                    'cat <<A > x.sh && sh x.sh\nrm -rf "$x"/*\nA',
                    'cat <<A > x.sh; source x.sh\nrm -rf "$x"/*\nA',
                    'cat <<A > x.sh; . x.sh\nrm -rf "$x"/*\nA',
                    'cat <<A > x.sh; exec x.sh\nrm -rf "$x"/*\nA'):
            with self.subTest(cmd=cmd):
                self.assertEqual(self.verdict(cmd)[0], "deny")

    def test_row_13_prose_heredoc_still_passes(self):
        self.assertIsNone(self.verdict("cat <<'EOT'\nnotes: the .pi dir and $x are prose\nEOT"))


class WholeTextPurityTest(unittest.TestCase):
    """Revision 3: a body is skipped only when every command of the whole text is a plain reader."""

    def verdict(self, command):
        return dg._check_command(command, tempfile.gettempdir())

    BODY = 'rm -rf "$x"/*'

    def test_any_other_command_in_the_text_keeps_the_body_scanned(self):
        b = self.BODY
        for cmd in ('cat <<A > x.sh; /tmp/x.sh\n%s\nA' % b,
                    'cat <<A > x.sh; timeout 5 bash x.sh\n%s\nA' % b,
                    'cat <<A > x.sh; env bash x.sh\n%s\nA' % b,
                    'cat <<A > x.sh; command bash x.sh\n%s\nA' % b,
                    'cat <<A > x.sh; nohup bash x.sh\n%s\nA' % b,
                    'cat <<A > x.sh; sudo bash x.sh\n%s\nA' % b,
                    'cat <<A > x.sh; echo x.sh | xargs -I{} bash {}\n%s\nA' % b,
                    'cat <<A > x.sh; python3 -c "import os; os.system(\'sh x.sh\')"\n%s\nA' % b,
                    'cat <<A > x.sh; perl -e \'system("sh x.sh")\'\n%s\nA' % b,
                    'cat <<A > x.sh; find . -exec bash x.sh \\;\n%s\nA' % b,
                    'cat <<A > x.sh; make -f x.sh\n%s\nA' % b,
                    'cat <<A > x.sh; at -f x.sh now\n%s\nA' % b,
                    'cat <<A > x.sh; watch bash x.sh\n%s\nA' % b,
                    'cat <<A > x.sh; crontab x.sh\n%s\nA' % b,
                    'cat <<A > x.sh; s""h x.sh\n%s\nA' % b,
                    'cat <<A > x.sh; b\\ash x.sh\n%s\nA' % b,
                    'cat <<A > x.sh; $SHELL x.sh\n%s\nA' % b,
                    'for i in 1 2; do bash x.sh; cat <<A > x.sh; done\n%s\nA' % b,
                    'cat <<A > x.sh\n%s\nA\nbash x.sh' % b,
                    'cat <<A >> ~/.bashrc\n%s\nA' % b,
                    'cat <<A > .hidden\n%s\nA' % b,
                    'tee -a ~/.bashrc <<A\n%s\nA' % b,
                    'cat <<A; (bash x.sh)\n%s\nA' % b,
                    'cat <<A; echo $(bash x.sh)\n%s\nA' % b,
                    'cat <<A; x=1 cat y\n%s\nA' % b,
                    'cat <<A; sort -o x y\n%s\nA' % b):
            with self.subTest(cmd=cmd):
                self.assertEqual(self.verdict(cmd)[0], "deny")

    def test_dollar_bracket_and_brace_are_no_heredoc(self):
        for cmd in ('cat $[1<<2] 2>/dev/null; true\nrm -rf "$x"/*\n2]',
                    'cat ${x-<<A} 2>/dev/null; true\nrm -rf "$x"/*\nA}'):
            with self.subTest(cmd=cmd):
                self.assertEqual(self.verdict(cmd)[0], "deny")

    def test_unclosed_heredoc_skips_nothing(self):
        self.assertEqual(self.verdict('cat <<A\nrm -rf "$x"/*')[0], "deny")
        self.assertEqual(self.verdict('cat <<A <<B\nx\nA\nrm -rf "$x"/*')[0], "deny")

    def test_pure_reader_texts_keep_the_prose_skip(self):
        b = self.BODY
        for cmd in ("cat <<'EOT'\nnotes: the .pi dir and $x are prose\nEOT",
                    'cat > docs/x.md <<EOT\n%s\nEOT\ncat docs/x.md' % b,
                    'tee docs/x.md <<EOT\n%s\nEOT' % b,
                    'cat <<A && cat <<B\n%s\nA\n%s\nB' % (b, b),
                    'if cat <<A | grep x; then echo ok; fi\n%s\nA' % b,
                    '{ cat <<A; echo done; } 2>&1\n%s\nA' % b,
                    'for f in a b; do cat <<A; done\n%s\nA' % b,
                    'cat <<"A" >> out.txt 2>/dev/null\n%s\nA' % b):
            with self.subTest(cmd=cmd):
                self.assertIsNone(self.verdict(cmd))


if __name__ == "__main__":
    unittest.main()
