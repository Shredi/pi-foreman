"""git_guard.py: a command substitution or the word `git` in an ARGUMENT position is not a
computed program name; only the command word counts."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import git_guard as gg  # noqa: E402

READ_ONLY = [
    "ls -la $(npm root -g)/pi-foreman/extensions/git-guard",
    "grep -n foo /x/git-guard/index.ts",
    "grep -n foo $(npm root -g)/pi-foreman/extensions/git-guard/index.ts",
    "cat `npm root -g`/git/x",
    "ls -la \"$(npm root -g)\"/git | head",
    "[ -d $(npm root -g)/git ] && ls /x/git-guard",
    "[[ -d $(npm root -g)/git ]] && ls /x/git-guard",
]

STILL_REFUSED = [
    "$(npm root -g)/git push",
    "$G ls $(npm root -g)/git",
]


class ArgumentPositionTest(unittest.TestCase):
    def test_reader_lines_are_allowed(self):
        for cmd in READ_ONLY:
            for mode in ("child", "main"):
                with self.subTest(cmd=cmd, mode=mode):
                    self.assertEqual(gg.decide(cmd, mode).level, gg.ALLOW)

    def test_computed_command_word_still_refused(self):
        for cmd in STILL_REFUSED:
            with self.subTest(cmd=cmd):
                self.assertGreater(gg.decide(cmd, "main").level, gg.ALLOW)
                self.assertEqual(gg.decide(cmd, "child").level, gg.DENY)

    def test_test_builtin_does_not_hide_git(self):
        self.assertEqual(gg.decide("[ -d x ] && git push", "child").level, gg.DENY)


if __name__ == "__main__":
    unittest.main()
