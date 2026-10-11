"""destructive_guard.py: heredoc bodies are scanned like any shell text (harness-friction point 17, heredoc part not done)."""
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

    BODY = 'rm -rf "$x"/*'

    def test_destructive_text_in_a_heredoc_body_is_a_command(self):
        for body in ("rm -rf $x", "rm -rf /", "> $x"):
            for open_ in ("cat <<'EOT'", 'cat <<"EOT"', "cat <<EOT", "cat > docs/n.md <<'EOT'", "cat <<-EOT"):
                with self.subTest(body=body, open=open_):
                    self.assertEqual(self.verdict("%s\n%s\nEOT" % (open_, body))[0], "deny")

    def test_documented_limit_row_13_prose_is_scanned_like_any_text(self):
        # point 17: a body is not skipped, so prose that the guard reads as a command would trip it
        # (this prose does not); the way out for such text is the write tool.
        self.assertIsNone(self.verdict("cat <<'EOT'\nnotes: the .pi dir and $x are prose\nEOT"))
        self.assertEqual(self.verdict("cat <<'EOT'\nnotes\nrm -rf $x\nEOT")[0], "deny")

    def test_the_command_after_the_terminator_is_still_checked(self):
        self.assertEqual(self.verdict("cat <<'EOT'\nprose\nEOT\nrm -rf $x")[0], "deny")

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

    def test_a_reader_pipeline_body_is_scanned_too(self):
        for open_ in ("cat <<'EOF' | grep x", "cat <<EOF | tee out.txt | head", "grep -c x <<'EOF'", "sort <<EOF"):
            with self.subTest(open=open_):
                self.assertEqual(self.verdict('%s\nrm -rf "$x"/*\nEOF' % open_)[0], "deny")

    def test_arithmetic_shift_is_not_a_heredoc(self):
        for cmd in ('echo $((1<<2))\nrm -rf "$x"/*', 'x=$((1 << EOF))\nrm -rf "$x"/*', '((y=1<<2))\nrm -rf "$x"/*'):
            with self.subTest(cmd=cmd):
                self.assertEqual(self.verdict(cmd)[0], "deny")

    def test_fd_duplication_is_no_separator(self):
        self.assertIsNone(self.verdict("ls 2>&1"))
        self.assertEqual(self.verdict("ls 2>&1; rm -rf $x")[0], "deny")

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


class NegativeProbeTest(unittest.TestCase):
    """Revisions 1-4: texts a body skip would have wrongly allowed; every one is denied."""

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

    def test_review_4_reader_programs_with_script_or_output_flags(self):
        b = self.BODY
        for cmd in ('awk -E /dev/stdin x <<A\n%s\nA' % b,
                    'sed -n --fil=- x <<A\n%s\nA' % b,
                    'sort -S 1 --compress-prog=sh <<A\n%s\nA' % b,
                    'uniq - ~/.bashrc <<A\n%s\nA' % b,
                    'sort --o=.bashrc <<A\n%s\nA' % b,
                    'cd ~; tee bashrc <<A\n%s\nA' % b,
                    'less -o .bashrc <<A\n%s\nA' % b):
            with self.subTest(cmd=cmd):
                self.assertEqual(self.verdict(cmd)[0], "deny")

    def test_review_4_substitutions_in_an_unquoted_body(self):
        for cmd in ('cat <<A\n$(rm -rf "$x"/*)\nA', 'cat <<A\n`rm -rf "$x"/*`\nA'):
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


if __name__ == "__main__":
    unittest.main()
