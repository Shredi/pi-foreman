"""scripts/pr_ops.py read tools with `config.githubHosts` (tools.prGithubHosts): where a gh call names no host, the host list fills it in.

Only gh is affected; with the key unset or ["github.com"] every argv is today's.
"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures"))
from test_safe_ops import safe_ops  # noqa: E402
from test_safe_ops_pr import GH_CHECKS, GH_STATUS, PrCase, argv_of, j, pair  # noqa: E402

GHE = "ghe.example.test"
VIEW = {"comments": [], "reviews": []}


class GithubHostsTest(PrCase):
    def setUp(self):
        super().setUp()
        self.hosts("gh")

    def prh(self, op, hosts, **args):
        cfg = {"prHost": "auto"}
        if hosts is not None:
            cfg["githubHosts"] = hosts
        return safe_ops.handle({"op": op, "args": args, "cwd": self.repo, "config": cfg})

    def comments_scn(self):
        self.scn({"gh pr view 5": {"stdout": j(VIEW)}, "gh api": {"stdout": "[]"}})

    def api_argv(self):
        return argv_of(self.calls()[-1])

    def test_a_host_with_a_trailing_newline_is_invalid(self):
        self.scn({"gh pr view 7": {"stdout": j(GH_STATUS)}})
        self.ok(self.prh("pr_status", [GHE + "\n"], number=7, repo="o/r"))
        self.assertEqual(pair(argv_of(self.calls()[0]), "-R"), "o/r")

    def test_status_and_checks_with_a_repo_get_the_first_listed_host(self):
        self.scn({"gh pr view 7": {"stdout": j(GH_STATUS)}, "gh pr checks": {"stdout": j(GH_CHECKS), "exit": 8}})
        self.ok(self.prh("pr_status", [GHE, "github.com"], number=7, repo="o/r"))
        self.assertEqual(pair(argv_of(self.calls()[0]), "-R"), GHE + "/o/r")
        self.ok(self.prh("pr_checks", [GHE.upper()], number=7, repo="o/r"))
        self.assertEqual(pair(argv_of(self.calls()[1]), "-R"), GHE + "/o/r")

    def test_find_with_a_repo_gets_the_host_and_an_explicit_host_wins(self):
        self.scn({"gh pr list": {"stdout": "[]"}})
        self.ok(self.prh("pr_find", [GHE], author="@me", repo="o/r"))
        self.assertEqual(pair(argv_of(self.calls()[0]), "-R"), GHE + "/o/r")
        self.ok(self.prh("pr_find", [GHE], author="@me", repo="o/r", host="other.example.test"))
        self.assertEqual(pair(argv_of(self.calls()[1]), "-R"), "other.example.test/o/r")

    def test_unset_default_and_invalid_lists_keep_todays_argv(self):
        self.scn({"gh pr view 7": {"stdout": j(GH_STATUS)}})
        for n, hosts in enumerate((None, ["github.com"], ["GitHub.com"], [], ["-bad"], ["a..b"], "ghe", ["x"] * 21 + ["ghe.example.test"], [5])):
            self.ok(self.prh("pr_status", hosts, number=7, repo="o/r"))
            self.assertEqual(pair(argv_of(self.calls()[n]), "-R"), "o/r", hosts)
        self.ok(self.prh("pr_status", [GHE], number=7))
        self.assertNotIn("-R", argv_of(self.calls()[-1]))

    def test_comments_without_a_repo_and_without_a_remote_use_the_first_listed_host(self):
        self.comments_scn()
        self.ok(self.prh("pr_comments", [GHE, "github.com"], number=5))
        view = argv_of(self.calls()[0])
        self.assertNotIn("-R", view)
        self.assertEqual(pair(self.api_argv(), "--hostname"), GHE)
        self.assertEqual(self.api_argv()[-1], "repos/{owner}/{repo}/pulls/5/comments?per_page=100")

    def test_comments_without_a_repo_with_a_github_remote_add_no_hostname(self):
        self.comments_scn()
        self.git("remote", "add", "origin", "https://github.com/own/repo.git")
        self.ok(self.prh("pr_comments", [GHE], number=5))
        self.assertNotIn("--hostname", self.api_argv())

    def test_comments_without_a_repo_follow_a_listed_remote_host(self):
        self.comments_scn()
        self.git("remote", "add", "origin", "https://%s/own/repo.git" % GHE)
        self.ok(self.prh("pr_comments", ["github.com", GHE], number=5))
        self.assertEqual(pair(self.api_argv(), "--hostname"), GHE)

    def test_comments_with_an_unlisted_remote_or_an_ssh_alias_add_no_hostname(self):
        self.comments_scn()
        self.git("remote", "add", "origin", "https://other.example.test/own/repo.git")
        self.ok(self.prh("pr_comments", [GHE], number=5))
        self.assertNotIn("--hostname", self.api_argv())
        self.git("remote", "set-url", "origin", "git@github-work:own/repo.git")
        self.ok(self.prh("pr_comments", [GHE], number=5))
        self.assertNotIn("--hostname", self.api_argv())
        self.git("remote", "set-url", "origin", "https://other.example.test/own/repo.git")
        self.ok(self.prh("pr_comments", None, number=5))
        self.assertNotIn("--hostname", self.api_argv())

    def test_comments_without_a_repo_and_the_default_list_run_as_today(self):
        self.comments_scn()
        for hosts in (None, ["github.com"], ["bad host"]):
            self.ok(self.prh("pr_comments", hosts, number=5))
            self.assertNotIn("--hostname", self.api_argv())
            self.assertNotIn("-R", argv_of(self.calls()[-2]))

    def test_comments_with_a_repo_use_the_host_for_view_and_inline_comments(self):
        self.comments_scn()
        self.ok(self.prh("pr_comments", [GHE, "github.com"], number=5, repo="o/r"))
        self.assertEqual(pair(argv_of(self.calls()[0]), "-R"), GHE + "/o/r")
        self.assertEqual(pair(self.api_argv(), "--hostname"), GHE)
        self.assertEqual(self.api_argv()[-1], "repos/o/r/pulls/5/comments?per_page=100")

    def test_comments_with_a_repo_and_the_default_list_add_nothing(self):
        self.comments_scn()
        self.ok(self.prh("pr_comments", ["github.com"], number=5, repo="o/r"))
        self.assertEqual(pair(argv_of(self.calls()[0]), "-R"), "o/r")
        self.assertNotIn("--hostname", self.api_argv())

    def test_a_host_without_a_repo_is_still_refused(self):
        self.failed(self.prh("pr_comments", [GHE], number=5, host=GHE), "bad_request")


class GlabUntouchedTest(PrCase):
    def test_glab_gets_no_host_from_the_list(self):
        self.hosts("glab")
        self.scn({"glab mr view": {"stdout": j({"iid": 7, "web_url": "https://x.example/7", "state": "opened", "title": "t"})}})
        safe_ops.handle({"op": "pr_status", "args": {"number": 7, "repo": "o/r"}, "cwd": self.repo,
                         "config": {"prHost": "auto", "githubHosts": [GHE]}})
        calls = self.calls()
        self.assertEqual(pair(argv_of(calls[0]), "-R"), "o/r")


if __name__ == "__main__":
    unittest.main()
