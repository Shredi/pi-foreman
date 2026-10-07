"""git_guard.py PR gate: a pull/merge request is created only for a head a reviewer passed
(payload `pr_gate`); children never create one. Decisions over command strings; git only
sets up the temp repo."""
import json
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


FORMS = [
    "gh pr create --title x --body y",
    "gh pr create --head feat --fill",
    "gh api repos/o/r/pulls -X POST -f title=x -f head=main -f base=main",
    "gh api repos/o/r/pulls -f title=x",
    "gh api repos/o/r/pulls/7 --method PATCH -f state=closed",
    "glab mr create --fill",
    "glab merge-request new --fill",
    "hub pull-request -m x",
    "tea pr create --title x",
    "tea pulls create --title x",
    "git push -o merge_request.create origin main",
    "git push --push-option=merge_request.create origin main",
    "git push --push-option merge_request.target=main origin main",
    "git push -omerge_request.create origin main",
    "git push -o topic=x origin main",
    "git push -o pull_request origin main",
    "git push origin HEAD:refs/for/main",
]
UNGATED = [
    "gh pr view 3",
    "gh pr list",
    "gh pr create --help",
    "gh api repos/o/r/pulls",
    "gh api repos/o/r/pulls -X GET -f state=open",
    "gh api repos/o/r/pulls/3/comments -f body=x",
    "gh issue create --title x",
    "git push -o ci.skip origin main",
    "git push -o merge_request.create -n origin main",
    "git push origin main",
]


@unittest.skipIf(shutil.which("git") is None, "git not on PATH")
class PrGateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.repo = tempfile.mkdtemp(prefix="pf-gg-pr-")
        git(cls.repo, "init", "-q", "-b", "main")
        git(cls.repo, "config", "user.email", "t@example.invalid")
        git(cls.repo, "config", "user.name", "t")
        git(cls.repo, "commit", "-q", "--allow-empty", "-m", "chore: init")
        cls.head = git(cls.repo, "rev-parse", "HEAD")
        git(cls.repo, "branch", "feat")
        git(cls.repo, "commit", "-q", "--allow-empty", "-m", "chore: two")
        cls.newer = git(cls.repo, "rev-parse", "HEAD")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.repo, ignore_errors=True)

    def decide(self, cmd, heads, mode="main", enabled=True, flavor="bash"):
        return gg.decide(cmd, mode, cwd=self.repo, flavor=flavor, pr_gate={"enabled": enabled, "reviewed_heads": heads})

    def test_no_review(self):
        for cmd in FORMS:
            d = self.decide(cmd, [])
            self.assertEqual(d.level, gg.DENY, cmd)
            self.assertIn("pr_refused:no_review", d.reason, cmd)
            self.assertIn("reviewer", d.reason)

    def test_pass_at_head_allowed(self):
        for cmd in FORMS:
            if "feat" in cmd or "refs/for" in cmd or cmd.startswith("git push"):
                continue  # these name another ref; covered below
            self.assertEqual(self.decide(cmd, [self.newer]).level, gg.ALLOW, cmd)
        self.assertEqual(self.decide("git push -o merge_request.create origin HEAD:main", [self.newer]).level, gg.ALLOW)
        self.assertEqual(self.decide("git push origin HEAD:refs/for/main", [self.newer]).level, gg.ALLOW)

    def test_stale_review(self):
        for cmd in ("gh pr create --fill", "git push -o merge_request.create origin main"):
            d = self.decide(cmd, [self.head])
            self.assertIn("pr_refused:stale_review", d.reason, cmd)

    def test_head_ref_is_resolved(self):
        # `--head feat` points at the older commit, so the review of HEAD does not cover it.
        self.assertIn("stale_review", self.decide("gh pr create --head feat", [self.newer]).reason)
        self.assertEqual(self.decide("gh pr create --head feat", [self.head]).level, gg.ALLOW)
        self.assertIn("head_unknown", self.decide("gh pr create --head nosuch", [self.head]).reason)

    def test_head_unknown_outside_a_repository(self):
        with tempfile.TemporaryDirectory() as plain:
            d = gg.decide("gh pr create --fill", "main", cwd=plain, pr_gate={"enabled": True, "reviewed_heads": [self.head]})
            self.assertEqual(d.level, gg.DENY)
            self.assertIn("pr_refused:head_unknown", d.reason)

    def test_ungated(self):
        for cmd in UNGATED:
            self.assertEqual(self.decide(cmd, []).level, gg.ALLOW, cmd)

    def test_disabled_or_absent(self):
        self.assertEqual(self.decide("gh pr create --fill", [], enabled=False).level, gg.ALLOW)
        self.assertEqual(gg.decide("gh pr create --fill", "main", cwd=self.repo).level, gg.ALLOW)

    def test_child_refused_every_form(self):
        for cmd in FORMS:
            d = self.decide(cmd, [self.newer], mode="child")
            self.assertEqual(d.level, gg.DENY, cmd)
        for cmd in FORMS:
            if not cmd.startswith("git "):
                self.assertIn("pr_refused:child", self.decide(cmd, [self.newer], mode="child").reason, cmd)
        self.assertIn("pr_refused:child", self.decide("git push -o merge_request.create origin main", [], mode="child").reason)
        self.assertEqual(self.decide("gh pr list", [], mode="child").level, gg.ALLOW)

    def test_powershell_and_wrappers(self):
        self.assertIn("no_review", self.decide("gh pr create --fill", [], flavor="powershell").reason)
        self.assertIn("no_review", self.decide("& gh pr create --fill", [], flavor="powershell").reason)
        self.assertIn("no_review", self.decide("cd . && sudo gh pr create --fill", []).reason)

    def test_payload_entry_point(self):
        payload = {"tool_name": "powershell", "tool_input": {"command": "gh pr create --fill"}, "cwd": self.repo,
                   "shell": "powershell", "pr_gate": {"enabled": True, "reviewed_heads": []}}
        r = subprocess.run([sys.executable, str(ROOT / "scripts" / "git_guard.py"), "--mode", "main"],
                           input=json.dumps(payload).encode(), stdout=subprocess.PIPE, check=True)
        out = json.loads(r.stdout)["hookSpecificOutput"]
        self.assertEqual(out["permissionDecision"], "deny")
        self.assertIn("pr_refused:no_review", out["permissionDecisionReason"])


if __name__ == "__main__":
    unittest.main()
