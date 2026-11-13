"""No `.git` segment is writable below the own handoff dir: any case on every platform; on Windows trailing dots and spaces are dropped first."""
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import shell_write_guard as swg  # noqa: E402


class HandoffGitSegment(unittest.TestCase):
    def setUp(self):
        base = os.path.realpath(tempfile.mkdtemp(prefix="pf-swg-hg-"))
        self.addCleanup(shutil.rmtree, base, True)
        self.ws = os.path.join(base, "ws").replace(os.sep, "/")
        self.h = os.path.join(base, "agent", "handoffs", "h1").replace(os.sep, "/")
        os.makedirs(self.ws)
        os.makedirs(os.path.join(self.h, "work", "sub"))
        Path(self.ws, "a").write_text("a", "utf-8")

    def d(self, cmd):
        return swg.decide(cmd, self.ws, self.ws, "bash", None, None, None, self.h)

    def test_a_git_segment_is_refused_by_redirect_and_cp_in_any_case(self):
        for rel in ("work/.git/HEAD", "work/.GIT/HEAD", "work/.Git/config", "work/sub/.git", "work/sub/.git/x/y"):
            with self.subTest(rel=rel):
                self.assertIsNotNone(self.d(f"echo x > {self.h}/{rel}"))
                self.assertIsNotNone(self.d(f"cp {self.ws}/a {self.h}/{rel}"))
                self.assertIsNotNone(self.d(f'echo x > "$PI_FOREMAN_HANDOFF_DIR/{rel}"'))

    def test_a_git_directory_is_refused_as_a_move_target(self):
        os.makedirs(os.path.join(self.h, "work", ".git"))
        self.assertIsNotNone(self.d(f"mv {self.ws}/a {self.h}/work/.git/"))

    def test_names_that_only_contain_git_stay_writable(self):
        for rel in ("work/.gitignore", "work/a.git/x", "work/x.git", "work/legit/x.txt"):
            with self.subTest(rel=rel):
                self.assertIsNone(self.d(f"echo x > {self.h}/{rel}"))

    def test_windows_trailing_dots_and_spaces_are_dropped_before_the_match(self):
        scope = swg.Scope(self.ws, None, None, None, self.h)
        scope.handoff_nt = True
        for rel in ("work/.git./HEAD", "work/.git /HEAD", "work/.GIT.../x", "work/sub/.Git. ."):
            with self.subTest(rel=rel):
                real = os.path.join(scope.handoff, *rel.split("/"))
                self.assertTrue(scope._handoff_refuses(real, real), rel)
        ok = os.path.join(scope.handoff, "work", "x.txt")
        self.assertFalse(scope._handoff_refuses(ok, ok))

    def test_the_case_fold_holds_on_every_platform(self):
        scope = swg.Scope(self.ws, None, None, None, self.h)
        real = os.path.join(scope.handoff, "work", ".GIT", "HEAD")
        self.assertTrue(scope._handoff_refuses(real, real))


if __name__ == "__main__":
    unittest.main()
