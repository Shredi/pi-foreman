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


class NetworkExecOptionTest(unittest.TestCase):
    """fetch/pull/clone/push options that make git run a program are refused in every role."""

    BAD = [
        "git fetch --upload-pack='true' /x",
        "git fetch --upload-pack true /x",
        "git pull --upload-pack=true /x",
        "git clone --upload-pack=true /x y",
        "git clone -u true /x y",
        "git fetch -u true /x",
        "git push --receive-pack=true /x main",
        "git push --exec=true /x main",
        "git -c core.sshCommand=true fetch origin",
        "git -c core.gitProxy=true fetch origin",
        "git clone --config core.sshCommand=true /x y",
        "git -C . fetch --upload-pack=true /x",
    ]

    def test_refused_in_foreman_and_child(self):
        for cmd in self.BAD:
            with self.subTest(cmd=cmd):
                self.assertGreater(gg.decide(cmd, "main").level, gg.ALLOW)
                self.assertEqual(gg.decide(cmd, "child").level, gg.DENY)

    def test_plain_fetch_is_still_allowed_for_the_foreman(self):
        for cmd in ("git fetch origin", "git fetch", "git fetch --prune", "git push -u origin main"):
            with self.subTest(cmd=cmd):
                self.assertEqual(gg.decide(cmd, "main").level, gg.ALLOW)


if __name__ == "__main__":
    unittest.main()
