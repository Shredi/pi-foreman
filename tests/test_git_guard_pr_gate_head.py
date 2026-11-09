"""git_guard.py PR gate: the PR head's remote counterpart is the same-named remote branch, never a tracked base
(a worktree branch created from origin/main has upstream origin/main)."""
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import git_guard as gg  # noqa: E402


class PrGateHeadTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="pf-gg-prhead-")).resolve()
        self.origin = self.root / "origin.git"
        self.main = self.root / "main"
        self.wt = self.root / "wt"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(self.origin)], check=True)
        subprocess.run(["git", "clone", "-q", str(self.origin), str(self.main)], check=True, stderr=subprocess.DEVNULL)
        self.commit(self.main, "chore: base")
        self.git(self.main, "push", "-q", "origin", "main")
        self.git(self.main, "fetch", "-q", "origin")
        self.base = self.git(self.main, "rev-parse", "HEAD")
        self.git(self.main, "worktree", "add", "-q", "-b", "round/x", str(self.wt), "origin/main")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def git(self, cwd, *args):
        keep = "url.%s.pushInsteadOf=%s" % (self.origin, self.origin)
        return subprocess.run(["git", "-C", str(cwd), "-c", keep] + list(args), check=True, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE).stdout.decode().strip()

    def commit(self, cwd, msg):
        self.git(cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", msg)
        return self.git(cwd, "rev-parse", "HEAD")

    def decide(self, cmd, cwd, heads):
        return gg.decide(cmd, "main", cwd=str(cwd), flavor="bash", pr_gate={"enabled": True, "reviewed_heads": heads})

    def test_pass_on_worktree_head_opens_gate(self):
        head = self.commit(self.wt, "feat: x")
        self.git(self.wt, "push", "-q", "origin", "round/x")
        for cmd, cwd in (("gh pr create --fill", self.wt), ("gh pr create --head round/x --fill", self.wt),
                         ("gh pr create --head round/x --fill", self.main), ("glab mr create --fill", self.wt)):
            self.assertEqual(self.decide(cmd, cwd, [head]).level, gg.ALLOW, (cmd, cwd))

    def test_pass_on_base_sha_does_not_open_gate(self):
        head = self.commit(self.wt, "feat: x")
        self.git(self.wt, "push", "-q", "origin", "round/x")
        self.assertNotEqual(head, self.base)
        for cmd, cwd in (("gh pr create --fill", self.wt), ("gh pr create --head round/x --fill", self.wt)):
            d = self.decide(cmd, cwd, [self.base])
            self.assertEqual(d.level, gg.DENY, (cmd, cwd))
            self.assertIn("pr_refused:stale_review", d.reason, (cmd, cwd))
        # detached HEAD: no branch, no remote counterpart
        self.git(self.wt, "checkout", "-q", "--detach")
        self.assertIn("pr_refused:stale_review", self.decide("gh pr create --fill", self.wt, [self.base]).reason)

    def test_named_head_from_main_checkout_needs_its_own_commit(self):
        head = self.commit(self.wt, "feat: x")
        self.git(self.wt, "push", "-q", "origin", "round/x")
        for cmd in ("gh pr create --head round/x --fill", "gh pr create --head owner:round/x --fill",
                    "glab mr create --source-branch round/x --fill"):
            d = self.decide(cmd, self.main, [self.base])
            self.assertEqual(d.level, gg.DENY, cmd)
            self.assertIn("pr_refused:stale_review", d.reason, cmd)
            self.assertEqual(self.decide(cmd, self.main, [head]).level, gg.ALLOW, cmd)
        self.assertEqual(self.decide("gh pr create --fill", self.main, [self.base]).level, gg.ALLOW)

    def test_same_named_upstream_still_refuses_when_ahead(self):
        head = self.commit(self.wt, "feat: x")
        self.git(self.wt, "push", "-q", "-u", "origin", "round/x")
        other = self.root / "other"
        subprocess.run(["git", "clone", "-q", "-b", "round/x", str(self.origin), str(other)], check=True,
                       stderr=subprocess.DEVNULL)
        newer = self.commit(other, "feat: y")
        self.git(other, "push", "-q", "origin", "round/x")
        self.git(self.wt, "fetch", "-q", "origin")
        for cmd in ("gh pr create --fill", "gh pr create --head round/x --fill"):
            d = self.decide(cmd, self.wt, [head])
            self.assertIn("pr_refused:stale_review", d.reason, cmd)
            self.assertEqual(self.decide(cmd, self.wt, [head, newer]).level, gg.ALLOW, cmd)
            self.assertEqual(self.decide(cmd, self.wt, [newer]).level, gg.ALLOW, cmd)


if __name__ == "__main__":
    unittest.main()
