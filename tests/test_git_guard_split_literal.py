"""Ledger item 7f: a split / concatenated literal that reassembles a guarded token is denied (never asked)."""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import git_guard as gg  # noqa: E402

REASON = "split literal reassembles a guarded token"

DENIED = [
    "cat '.g''it'/config",                     # quoted pieces of one word
    "echo $'.'\"git\"",                          # ANSI-C piece + double-quoted piece
    "python3 -c 'p = \".g\" + \"it\"; open(p)'",   # literal chain inside inline code
    "node -e \"x = '.g' + 'it'\"",
    "python3 - <<EOF\nx = '.g' + 'it'\nEOF",     # chain inside a heredoc body
    "echo 'GI'T~1",
    "echo '.g'it.",
    "cat $'\\x2egit'/x",
    "echo '.GI''T'",
]
ALLOWED = [
    "python3 -c 'a = \"a\" + \"b\"'",
    "echo '.gi'",
    "echo .github",
    "cat .git/config",
    "cat '.git'/config",
    "node -e \"x = '.git' + '/config'\"",       # the token is whole in one piece: plain handling
    "git status",
    "echo 'a.git'",
]


class SplitLiteralTest(unittest.TestCase):
    def test_reassembled_tokens_are_denied_in_both_roles(self):
        for cmd in DENIED:
            for mode in ("main", "child"):
                with self.subTest(cmd=cmd, mode=mode):
                    d = gg.decide(cmd, mode)
                    self.assertEqual(d.level, gg.DENY)
                    self.assertEqual(d.reason, gg.PREFIX + REASON)

    def test_plain_and_unrelated_lines_are_not_this_rule(self):
        for cmd in ALLOWED:
            for mode in ("main", "child"):
                with self.subTest(cmd=cmd, mode=mode):
                    self.assertNotEqual(gg.decide(cmd, mode).reason, gg.PREFIX + REASON)

    def test_an_unterminated_quote_with_a_chain_is_denied_too(self):
        d = gg.decide("python3 -c '\".g\" + \"it\"' 'x", "main")
        self.assertEqual(d.level, gg.DENY)


class ReassembledTokenTest(unittest.TestCase):
    """R6 lane 1c: fragments joined by + .. concat join replace that spell a guarded command token (child mode)."""

    CASES = json.loads((ROOT / "tests" / "fixtures" / "split-literal-cases.json").read_text(encoding="utf-8"))

    def test_fixture_deny_list_is_denied_with_the_reason(self):
        for cmd in self.CASES["deny"]:
            with self.subTest(cmd=cmd):
                d = gg.decide(cmd, "child")
                self.assertEqual(d.level, gg.DENY)
                self.assertEqual(d.reason, gg.PREFIX + REASON)

    def test_fixture_allow_list_is_not_this_rule(self):
        for cmd in self.CASES["allow"]:
            with self.subTest(cmd=cmd):
                self.assertNotEqual(gg.decide(cmd, "child").reason, gg.PREFIX + REASON)

    def test_main_mode_keeps_its_old_behaviour(self):
        self.assertNotEqual(gg.decide('"c"+"d"', "main").reason, gg.PREFIX + REASON)


if __name__ == "__main__":
    unittest.main()
