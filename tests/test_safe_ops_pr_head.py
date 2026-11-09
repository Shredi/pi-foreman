"""pr_create precondition: the pushed head is the same-named remote branch, never a tracked base."""
import os
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_safe_ops_pr import PrCase, GH_URL  # noqa: E402


class PrCreateHeadTest(PrCase):
    def setUp(self):
        super().setUp()
        self.hosts("gh")
        origin = os.path.join(self.tmp, "origin.git")
        subprocess.run([self.git_bin(), "init", "-q", "--bare", origin], check=True)
        self.git("remote", "add", "origin", origin)
        self.git("push", "-q", "origin", self.default)
        self.git("fetch", "-q", "origin")
        # a worktree-style branch: created from origin/<default>, so its upstream is the base
        self.git("checkout", "-q", "-b", "feat", "--track", "origin/" + self.default)
        self.write("f.txt", "f\n")
        self.git("add", "f.txt")
        self.git("commit", "-q", "-m", "feat")
        self.scn({"gh pr create": {"stdout": GH_URL + "\n"}})

    @staticmethod
    def git_bin():
        from test_safe_ops_pr import GIT
        return GIT

    def create(self):
        return self.pr("pr_create", host="gh", title="t", body="b", base=self.default)

    def test_pushed_without_upstream_passes_precondition(self):
        self.git("push", "-q", "origin", "feat")
        self.assertEqual(self.git("config", "--get", "branch.feat.merge").strip(), "refs/heads/" + self.default)
        self.ok(self.create())

    def test_local_ahead_of_same_named_remote_is_refused(self):
        self.git("push", "-q", "origin", "feat")
        self.write("g.txt", "g\n")
        self.git("add", "g.txt")
        self.git("commit", "-q", "-m", "more")
        self.refused(self.create(), "unpushed")
        self.assertEqual(self.calls(), [])

    def test_missing_same_named_remote_is_refused(self):
        self.refused(self.create(), "unpushed")
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
