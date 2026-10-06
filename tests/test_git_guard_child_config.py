"""git_guard.py child mode: config writes are an allowlist, remotes and upstreams are fixed
(security review cycle 2, T5). Decisions over command STRINGS only; git is used only to
create the temp repo the guard reads from."""
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import git_guard as gg  # noqa: E402

DENIED = [
    "git config url.https://evil.example/.insteadOf https://github.com/",
    "git config --global url.https://evil.example/.insteadOf https://github.com/",
    "git config --global user.name x",
    "git config --system user.email x",
    "git config --file .git/config user.name x",
    "git config protocol.ext.allow always",
    "git config interactive.diffFilter x",
    "git config submodule.x.update '!sh -c x'",
    "git config core.alternateRefsCommand x",
    "git config help.autocorrect immediate",
    "git config set core.fsmonitor x",
    "git config --add remote.origin.pushurl x",
    "git config --unset-all core.hooksPath",
    "git config --remove-section core",
    "git config rename-section core x",
    "git remote add evil git@evil.invalid:x",
    "git remote set-url origin /tmp/x",
    "git remote set-url --push origin git@evil.invalid:x",
    "git remote rename origin o2",
    "git remote remove origin",
    "git remote rm origin",
    "git remote set-head origin -a",
    "git remote set-branches origin x",
    "git branch -u origin/main",
    "git branch --set-upstream-to=origin/main",
    "git branch --unset-upstream",
]
ALLOWED = [
    "git config user.name t",
    "git config user.email t@example.invalid",
    "git config set user.name t",
    "git config --unset user.email",
    "git config --get remote.origin.url",
    "git config --list --show-origin",
    "git config --global --get user.name",
    "git config --file .git/config --list",
    "git config core.fsmonitor",
    "git remote",
    "git remote -v",
    "git remote get-url origin",
    "git remote show origin",
    "git branch feat",
    "git branch -d feat",
]


@unittest.skipIf(shutil.which("git") is None, "git not on PATH")
class ChildConfigTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="pf-gg-t5-")
        subprocess.run(["git", "init", "-q", cls.tmp], check=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def decide(self, cmd, mode="child"):
        return gg.decide(cmd, mode, cwd=self.tmp).level

    def test_denied_for_children(self):
        for cmd in DENIED:
            with self.subTest(cmd=cmd):
                self.assertEqual(self.decide(cmd), gg.DENY)

    def test_allowed_for_children(self):
        for cmd in ALLOWED:
            with self.subTest(cmd=cmd):
                self.assertEqual(self.decide(cmd), gg.ALLOW)

    def test_main_mode_unchanged(self):
        for cmd in ("git remote add up git@example.invalid:x", "git config url.a.insteadOf b", "git branch -u origin/main"):
            with self.subTest(cmd=cmd):
                self.assertEqual(self.decide(cmd, "main"), gg.ALLOW)


if __name__ == "__main__":
    unittest.main()
