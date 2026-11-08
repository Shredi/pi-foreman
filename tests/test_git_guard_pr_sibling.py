"""git_guard.py PR gate, sibling checkouts: `gh pr create --repo X --head B` from the session checkout opens only
when exactly one checkout with a recorded reviewer PASS (payload `pr_gate.reviewed_checkouts`) has a remote X and
its branch B at the PASS head; `cd <dir> && gh pr create` stays refused and names `pr_create {cwd}`."""
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import git_guard as gg  # noqa: E402


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd)] + list(args), check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE).stdout.decode().strip()


def make_repo(url, branch="feat"):
    d = tempfile.mkdtemp(prefix="pf-gg-sib-")
    git(d, "init", "-q", "-b", "main")
    git(d, "config", "user.email", "t@example.invalid")
    git(d, "config", "user.name", "t")
    git(d, "commit", "-q", "--allow-empty", "-m", "chore: init")
    git(d, "checkout", "-q", "-b", branch)
    git(d, "commit", "-q", "--allow-empty", "-m", "chore: work")
    git(d, "remote", "add", "origin", url)
    git(d, "checkout", "-q", "main")
    return d


@unittest.skipIf(shutil.which("git") is None, "git not on PATH")
class PrSiblingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.session = make_repo("https://github.com/o/session.git")
        cls.sib = make_repo("git@github.com:o/sib.git")
        cls.sib2 = make_repo("https://github.com/o/sib")
        cls.dirs = [cls.session, cls.sib, cls.sib2]
        cls.sib_head = git(cls.sib, "rev-parse", "refs/heads/feat")
        cls.sib2_head = git(cls.sib2, "rev-parse", "refs/heads/feat")

    @classmethod
    def tearDownClass(cls):
        for d in cls.dirs:
            shutil.rmtree(d, ignore_errors=True)

    def decide(self, cmd, checkouts, mode="main", enabled=True):
        gate = {"enabled": enabled, "reviewed_heads": [], "reviewed_checkouts": checkouts}
        return gg.decide(cmd, mode, cwd=self.session, pr_gate=gate)

    def entry(self, d, head):
        return {"cwd": d, "head": head}

    def test_single_match_accepted(self):
        d = self.decide("gh pr create --repo o/sib --head feat --fill", [self.entry(self.sib, self.sib_head)])
        self.assertEqual(d.level, gg.ALLOW, d.reason)
        d = self.decide("gh pr create -R github.com/o/sib -H feat --fill", [self.entry(self.sib, self.sib_head)])
        self.assertEqual(d.level, gg.ALLOW, d.reason)

    def test_session_checkout_unchanged(self):
        d = self.decide("gh pr create --head feat", [])
        self.assertIn("pr_refused:no_review", d.reason)
        d = self.decide("gh pr create --repo o/session --head feat", [])
        self.assertEqual(d.level, gg.DENY)
        self.assertIn("pr_refused:", d.reason)

    def test_none_matches(self):
        for checkouts in ([], [self.entry(self.sib, self.sib_head)]):
            d = self.decide("gh pr create --repo o/other --head feat", checkouts)
            self.assertEqual(d.level, gg.DENY)
            self.assertIn("pr_refused:repo_unmatched", d.reason)
            self.assertIn("pr_create", d.reason)
            self.assertIn("cwd", d.reason)

    def test_stale_pass_does_not_match(self):
        git(self.sib, "checkout", "-q", "feat")
        try:
            git(self.sib, "commit", "-q", "--allow-empty", "-m", "chore: more")
            d = self.decide("gh pr create --repo o/sib --head feat", [self.entry(self.sib, self.sib_head)])
            self.assertIn("pr_refused:repo_unmatched", d.reason)
        finally:
            git(self.sib, "reset", "-q", "--hard", self.sib_head)
            git(self.sib, "checkout", "-q", "main")

    def test_ambiguous(self):
        d = self.decide("gh pr create --repo o/sib --head feat",
                        [self.entry(self.sib, self.sib_head), self.entry(self.sib2, self.sib2_head)])
        self.assertEqual(d.level, gg.DENY)
        self.assertIn("pr_refused:repo_ambiguous", d.reason)
        self.assertIn("pr_create", d.reason)

    def test_missing_head_or_computed_repo_not_resolved(self):
        d = self.decide("gh pr create --repo o/sib --fill", [self.entry(self.sib, self.sib_head)])
        self.assertIn("pr_refused:", d.reason)
        d = self.decide("gh pr create --repo $R --head feat", [self.entry(self.sib, self.sib_head)])
        self.assertEqual(d.level, gg.DENY)

    def test_child_and_gate_off(self):
        d = self.decide("gh pr create --repo o/sib --head feat", [self.entry(self.sib, self.sib_head)], mode="child")
        self.assertIn("pr_refused:child", d.reason)
        d = self.decide("gh pr create --repo o/other --head feat", [], enabled=False)
        self.assertEqual(d.level, gg.ALLOW)

    def test_cd_compound_still_refused_and_names_the_fix(self):
        d = self.decide("cd %s && gh pr create --fill" % self.sib, [self.entry(self.sib, self.sib_head)])
        self.assertEqual(d.level, gg.DENY)
        self.assertIn("pr_refused:pr_compound", d.reason)
        self.assertIn("pr_create", d.reason)
        self.assertIn("{cwd:", d.reason)


if __name__ == "__main__":
    unittest.main()
