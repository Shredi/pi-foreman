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
    "git push -o mr.create origin main",
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
        self.assertIn("no_review", self.decide("echo x && sudo gh pr create --fill", []).reason)

    def assertRefused(self, cmd, reason, heads=None, **kw):
        d = self.decide(cmd, [self.newer] if heads is None else heads, **kw)
        self.assertEqual(d.level, gg.DENY, cmd)
        self.assertIn("pr_refused:%s" % reason, d.reason, cmd)
        return d

    def test_gh_pr_new_and_aliases(self):
        # B-B1: `pr new` is gh's alias of `pr create`; user aliases and extensions cannot be read.
        self.assertRefused("gh pr new --fill", "no_review", [])
        self.assertEqual(self.decide("gh pr new --fill", [self.newer]).level, gg.ALLOW)
        for cmd in ("gh alias set mk 'pr create --fill'", "gh alias import a.yml", "gh mk", "gh my-ext run"):
            self.assertRefused(cmd, "pr_alias")
            self.assertRefused(cmd, "child", mode="child")
            self.assertEqual(self.decide(cmd, [], enabled=False).level, gg.ALLOW, cmd)
        for cmd in ("gh alias list", "gh co 3", "gh repo view", "gh --version"):
            self.assertEqual(self.decide(cmd, []).level, gg.ALLOW, cmd)

    def test_push_options_from_config(self):
        # B-B2: -c, GIT_CONFIG_* in the environment, `git config` writes, the repository config.
        for cmd in ("git -c push.pushOption=merge_request.create push origin main",
                    "git -c PUSH.PUSHOPTION=mr.create push origin main",
                    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=push.pushOption GIT_CONFIG_VALUE_0=x git push origin main",
                    "export GIT_CONFIG_PARAMETERS=\"'core.x'='y'\"; git push origin main",
                    "env GIT_CONFIG_PARAMETERS=\"'core.x'='y'\" git push origin main"):
            self.assertRefused(cmd, "no_review", [])
        self.assertEqual(self.decide("git -c push.pushOption=ci.skip push origin HEAD:main", []).level, gg.ALLOW)
        for cmd in ("git config push.pushOption merge_request.create", "git config --add push.pushoption topic=x",
                    "git config set --global push.pushOption mr.create"):
            self.assertRefused(cmd, "pr_config")
            self.assertRefused(cmd, "child", mode="child")
        for cmd in ("git config push.pushOption ci.skip", "git config --get-all push.pushOption"):
            self.assertEqual(self.decide(cmd, []).level, gg.ALLOW, cmd)
        git(self.repo, "config", "push.pushOption", "merge_request.create")
        try:
            self.assertRefused("git push origin HEAD:main", "no_review", [])
            self.assertEqual(self.decide("git push origin HEAD:main", [self.newer]).level, gg.ALLOW)
        finally:
            git(self.repo, "config", "--unset-all", "push.pushOption")

    def test_compound(self):
        # B-M1/B-M2: the head is resolved before any segment runs.
        for cmd in ("git commit --allow-empty -m 'fix: x' && gh pr create --fill", "git reset --soft HEAD~1 && gh pr create",
                    "git switch feat; gh pr create --fill", "cd ../other && gh pr create",
                    "cd ../wt && git push -o merge_request.create origin main", "git branch -f main feat && gh pr create",
                    "git push origin main && git push -o mr.create origin main"):
            d = self.assertRefused(cmd, "pr_compound")
            self.assertIn("run the PR step on its own", d.reason)
        self.assertRefused("Set-Location ..\\x; gh pr create", "pr_compound", flavor="powershell")
        self.assertEqual(self.decide("git status && gh pr create --fill", [self.newer]).level, gg.ALLOW)
        self.assertEqual(self.decide("cd . && git commit --allow-empty -m 'fix: x'", []).level, gg.ALLOW)

    def test_upstream_must_be_reviewed(self):
        # B-M3: gh opens the PR from the remote branch.
        git(self.repo, "update-ref", "refs/remotes/origin/main", self.head)
        git(self.repo, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
        git(self.repo, "config", "branch.main.remote", "origin")
        git(self.repo, "config", "branch.main.merge", "refs/heads/main")
        try:
            d = self.assertRefused("gh pr create --fill", "stale_review")
            self.assertIn(self.head[:12], d.reason)
            self.assertEqual(self.decide("gh pr create --fill", [self.newer, self.head]).level, gg.ALLOW)
        finally:
            git(self.repo, "config", "--remove-section", "branch.main")
            git(self.repo, "config", "--remove-section", "remote.origin")
            git(self.repo, "update-ref", "-d", "refs/remotes/origin/main")

    def test_graphql_unreadable_body(self):
        # B-M5
        for cmd in ("gh api graphql -F query=@q.graphql", "gh api graphql --input q.json",
                    "gh api graphql -f query=@q.graphql", "gh api graphql -f query=\"$Q\""):
            self.assertRefused(cmd, "no_review", [])
            self.assertRefused(cmd, "child", mode="child")
        self.assertEqual(self.decide("gh api graphql -f query='{ viewer { login } }'", []).level, gg.ALLOW)

    def test_dynamic_refspec(self):
        # A computed refspec on a PR push is refused (it used to crash the guard).
        for cmd in ("git push -o merge_request.create origin $(git rev-parse feat):main",
                    "git push origin \"$X\":refs/for/main"):
            self.assertRefused(cmd, "head_unknown")
        self.assertNotIn("pr_refused", self.decide("git push origin $X", []).reason)

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
