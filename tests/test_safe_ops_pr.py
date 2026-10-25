"""scripts/pr_ops.py through safe_ops.handle: the PR ops against a fake gh/glab (design/pr-ops.md).

Repositories, shims and scenarios live in temp dirs this test creates; the base class removes them.
"""
import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures"))
import test_safe_ops as base  # noqa: E402
from test_safe_ops import safe_ops  # noqa: E402
from pr_host_shims import make_bin  # noqa: E402

GIT = shutil.which("git")
GH_URL = "https://github.com/own/repo/pull/12"


def j(x):
    return json.dumps(x)


class PrCase(base.SafeOpsCase):
    def setUp(self):
        super().setUp()
        self.fake = os.path.join(self.tmp, "fake")
        os.mkdir(self.fake)
        self.scn({})
        self.default = self.git("symbolic-ref", "--short", "HEAD").strip()

    def use_path(self, *dirs):
        """PATH holds only `dirs` (a developer's real gh must not leak in); git is pinned by its full path."""
        p = mock.patch.dict(os.environ, {"PATH": os.pathsep.join(dirs), "FAKE_PR_HOST_DIR": self.fake})
        w = mock.patch.object(safe_ops.shutil, "which", lambda name, *a, **k: GIT if name == "git" else None)
        for x in (p, w):
            x.start()
            self.addCleanup(x.stop)

    def hosts(self, *kinds):
        self.use_path(make_bin(self.tmp, kinds))

    def git(self, *args, cwd=None):
        """Base-class helper, but with git's full path (PATH is restricted while a host is installed)."""
        r = subprocess.run([GIT] + list(args), cwd=cwd or self.repo, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(r.returncode, 0, r.stderr.decode())
        return r.stdout.decode()

    def scn(self, scenario):
        Path(self.fake, "scenario.json").write_text(j(scenario), "utf-8")

    def calls(self):
        p = Path(self.fake, "calls.jsonl")
        return [json.loads(x) for x in p.read_text("utf-8").splitlines()] if p.exists() else []

    def pr(self, op, host="auto", **args):
        return safe_ops.handle({"op": op, "args": args, "cwd": self.repo, "config": {"prHost": host}})

    def ready(self, remote_url="https://example.com/own/repo.git"):
        """Branch feat with an origin that has it (upstream equal) and origin/HEAD on the default branch."""
        self.git("remote", "add", "origin", remote_url)
        self.git("update-ref", "refs/remotes/origin/" + self.default, "HEAD")
        self.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/" + self.default)
        self.git("checkout", "-q", "-b", "feat")
        self.write("f.txt", "f\n")
        self.git("add", "f.txt")
        self.git("commit", "-q", "-m", "feat")
        self.git("update-ref", "refs/remotes/origin/feat", "HEAD")
        self.git("config", "branch.feat.remote", "origin")
        self.git("config", "branch.feat.merge", "refs/heads/feat")

    def ok(self, res):
        self.assertTrue(res["ok"], res)
        return res

    def refused(self, res, name):
        self.failed(res, name)
        return res


GH_STATUS = {"number": 7, "url": "https://github.com/own/repo/pull/7", "state": "OPEN", "isDraft": True,
             "mergeable": "MERGEABLE", "reviewDecision": "", "headRefOid": "abc", "baseRefName": "main",
             "updatedAt": "2026-01-01T00:00:00Z"}
GH_CHECKS = [{"name": "a", "state": "SUCCESS", "bucket": "pass", "link": "u1", "startedAt": "s", "completedAt": "c"},
             {"name": "b", "state": "FAILURE", "bucket": "fail", "link": "u2", "startedAt": "s", "completedAt": "c"},
             {"name": "c", "state": "PENDING", "bucket": "pending", "link": "u3", "startedAt": "s", "completedAt": ""}]


class GhTest(PrCase):
    def setUp(self):
        super().setUp()
        self.hosts("gh")

    def test_status_normalised(self):
        self.scn({"gh pr view 7": {"stdout": j(GH_STATUS)}})
        res = self.ok(self.pr("pr_status", number=7))
        self.assertEqual((res["state"], res["draft"], res["mergeable"], res["reviewDecision"], res["headSha"], res["baseRef"]),
                         ("open", True, "mergeable", None, "abc", "main"))
        self.assertEqual(self.calls()[0]["argv"][:4], ["gh", "pr", "view", "7"])

    def test_checks_exit_8_with_json_counts_as_success(self):
        self.scn({"gh pr checks": {"stdout": j(GH_CHECKS), "exit": 8}})
        res = self.ok(self.pr("pr_checks"))
        self.assertEqual([len(res[k]) for k in ("pending", "failed", "passed")], [1, 1, 1])
        self.assertEqual(res["summary"], "1 passed, 1 failed (b), 1 pending")
        self.assertEqual((res["failed"][0]["status"], res["failed"][0]["conclusion"]), ("completed", "failure"))
        self.assertEqual((res["pending"][0]["status"], res["pending"][0]["conclusion"]), ("pending", None))

    def test_checks_none_reported(self):
        self.scn({"gh pr checks": {"stderr": "no checks reported on the 'x' branch\n", "exit": 1}})
        res = self.ok(self.pr("pr_checks"))
        self.assertEqual((res["summary"], res["passed"], res["total"]), ("no checks reported", [], 0))

    def test_comments_three_sources_since_cut_and_redaction(self):
        token = "ghp_" + "a" * 24
        view = {"comments": [{"id": "IC1", "author": {"login": "u1"}, "createdAt": "2026-01-02T00:00:00Z", "body": "see " + token + "\x07x"}],
                "reviews": [{"id": "R1", "author": {"login": "u2"}, "submittedAt": "2026-01-03T00:00:00Z", "body": "ok", "state": "APPROVED"},
                            {"id": "R2", "author": {"login": "u2"}, "submittedAt": "2026-01-03T01:00:00Z", "body": "", "state": "COMMENTED"},
                            {"id": "R3", "author": {"login": "u2"}, "submittedAt": "2026-01-03T02:00:00Z", "body": "draft", "state": "PENDING"}]}
        inline = [{"id": 9, "user": {"login": "u3"}, "created_at": "2026-01-04T00:00:00Z", "body": "x" * 600, "path": "a.py", "original_line": 4}]
        self.scn({"gh pr view 5": {"stdout": j(view)}, "gh api": {"stdout": j(inline)}})
        res = self.ok(self.pr("pr_comments", number=5))
        self.assertEqual([(c["kind"], c["id"]) for c in res["comments"]],
                         [("review", "9"), ("review_summary", "R1"), ("issue", "IC1")])
        self.assertEqual((res["comments"][0]["path"], res["comments"][0]["line"], res["comments"][0]["bodyCut"]), ("a.py", 4, True))
        self.assertEqual(len(res["comments"][0]["body"]), 500)
        self.assertEqual(res["comments"][1]["state"], "approved")
        self.assertEqual(res["comments"][2]["body"], "see ***x")
        res = self.ok(self.pr("pr_comments", number=5, since="2026-01-03T00:30:00Z"))
        self.assertEqual([c["id"] for c in res["comments"]], ["9"])

    def test_create_uses_body_file_and_removes_it(self):
        self.ready()
        self.scn({"gh pr create": {"stdout": GH_URL + "\n"}})
        res = self.ok(self.pr("pr_create", title="T 1", body="line1\nline2"))
        self.assertEqual((res["number"], res["url"], res["head"], res["base"]), (12, GH_URL, "feat", self.default))
        call = self.calls()[0]
        argv = call["argv"]
        self.assertEqual(call["body"], "line1\nline2")
        self.assertEqual((argv[argv.index("--head") + 1], argv[argv.index("--base") + 1], "--draft" in argv), ("feat", self.default, False))
        self.assertFalse(os.path.exists(argv[argv.index("--body-file") + 1]))
        self.pr("pr_create", title="T", body="b", draft=True)
        self.assertIn("--draft", self.calls()[1]["argv"])


class GlabTest(PrCase):
    def setUp(self):
        super().setUp()
        self.hosts("glab")

    def test_status_normalised(self):
        mr = {"iid": 3, "web_url": "u", "state": "opened", "draft": False, "detailed_merge_status": "not_approved",
              "sha": "def", "target_branch": "main", "updated_at": "2026-01-01T00:00:00Z"}
        self.scn({"glab mr view": {"stdout": j(mr)}})
        res = self.ok(self.pr("pr_status"))
        self.assertEqual((res["number"], res["state"], res["mergeable"], res["reviewDecision"], res["headSha"]),
                         (3, "open", "unknown", "review_required", "def"))

    def test_checks_allow_failure_goes_to_passed(self):
        jobs = [{"name": "j1", "status": "failed", "allow_failure": True, "web_url": "u"},
                {"name": "j2", "status": "failed", "web_url": "u"}, {"name": "j3", "status": "running"},
                {"name": "j4", "status": "success"}, {"name": "j5", "status": "canceled"}]
        self.scn({"glab mr view": {"stdout": j({"iid": 3, "head_pipeline": {"id": 9}})},
                  "glab api projects/:id/pipelines/9/jobs?per_page=100": {"stdout": j(jobs)}})
        res = self.ok(self.pr("pr_checks"))
        self.assertEqual(([e["name"] for e in res["failed"]], [e["name"] for e in res["pending"]]), (["j2", "j5"], ["j3"]))
        self.assertEqual([(e["name"], e["conclusion"]) for e in res["passed"]], [("j1", "allowed_failure"), ("j4", "success")])
        self.scn({"glab mr view": {"stdout": j({"iid": 3, "head_pipeline": None})}})
        self.assertEqual(self.ok(self.pr("pr_checks"))["summary"], "no checks reported")

    def test_comments_diffnote_and_system_notes(self):
        disc = [{"id": "d1", "notes": [
            {"id": 1, "type": "DiffNote", "author": {"username": "u1"}, "created_at": "2026-01-02T00:00:00.123Z", "body": "fix",
             "position": {"new_path": "a.py", "new_line": 8}, "resolvable": True, "resolved": False}]},
            {"id": "d2", "notes": [{"id": 2, "system": True, "author": {"username": "bot"}, "created_at": "2026-01-03T00:00:00Z", "body": "merged"},
                                   {"id": 3, "type": None, "author": {"username": "u2"}, "created_at": "2026-01-01T00:00:00Z", "body": "hi"}]}]
        self.scn({"glab mr view": {"stdout": j({"iid": 3})}, "glab api projects/:id/merge_requests/3/discussions?per_page=100": {"stdout": j(disc)}})
        res = self.ok(self.pr("pr_comments"))
        self.assertEqual([(c["id"], c["kind"]) for c in res["comments"]], [("1", "review"), ("3", "issue")])
        self.assertEqual((res["comments"][0]["path"], res["comments"][0]["line"], res["comments"][0]["resolved"]), ("a.py", 8, False))

    def test_create_posts_json_input(self):
        self.ready()
        self.scn({"glab api": {"stdout": j({"iid": 4, "web_url": "https://gitlab.example/o/r/-/merge_requests/4",
                                            "source_branch": "feat", "target_branch": self.default})}})
        res = self.ok(self.pr("pr_create", title="T", body="B", draft=True))
        self.assertEqual((res["number"], res["head"], res["base"]), (4, "feat", self.default))
        self.assertEqual(json.loads(self.calls()[0]["body"]),
                         {"source_branch": "feat", "target_branch": self.default, "title": "Draft: T", "description": "B"})


class HostResolutionTest(PrCase):
    def test_auto_prefers_gh_then_glab(self):
        self.scn({"gh pr view": {"stdout": j(GH_STATUS)}, "glab mr view": {"stdout": j({"iid": 3})}})
        self.hosts("gh", "glab")
        self.ok(self.pr("pr_status"))
        self.assertEqual(self.calls()[0]["argv"][0], "gh")

    def test_auto_falls_back_to_glab(self):
        self.scn({"glab mr view": {"stdout": j({"iid": 3})}})
        self.hosts("glab")
        self.ok(self.pr("pr_status"))
        self.assertEqual(self.calls()[0]["argv"][0], "glab")

    def test_binary_planted_in_workspace_is_skipped(self):
        self.use_path(make_bin(self.repo, ("gh",)))
        res = self.refused(self.pr("pr_status"), "pr_host_missing")
        self.assertIn("no PR host CLI found: install gh or glab outside the workspace, or set tools.prHost (docs/tools.md#pr-tools)", res["message"])
        self.assertEqual(self.calls(), [])

    def test_explicit_host_missing_hint(self):
        self.hosts("gh")
        res = self.refused(self.pr("pr_status", host="glab"), "pr_host_missing")
        self.assertIn("glab not found on PATH outside the workspace; install it or change tools.prHost", res["message"])

    def test_auth_missing_for_gh_and_glab(self):
        self.hosts("gh", "glab")
        self.scn({"gh pr view": {"stderr": "To get started with GitHub CLI, please run:  gh auth login\n", "exit": 4},
                  "glab mr view": {"stderr": "401 Unauthorized\n", "exit": 1}})
        res = self.refused(self.pr("pr_status", host="gh"), "pr_auth_missing")
        self.assertIn("run `gh auth login` yourself", res["message"])
        res = self.refused(self.pr("pr_status", host="glab"), "pr_auth_missing")
        self.assertIn("run `glab auth login` yourself", res["message"])

    def test_not_found_and_other_failure(self):
        self.hosts("gh", "glab")
        self.scn({"gh pr view": {"stderr": "no pull requests found for branch x\n", "exit": 1},
                  "glab mr view": {"stderr": "boom ghp_" + "b" * 24 + "\n", "exit": 1}})
        self.refused(self.pr("pr_status", host="gh"), "pr_not_found")
        res = self.pr("pr_status", host="glab")
        self.assertEqual((res["ok"], res["error"]), (False, "pr_host_failed"))
        self.assertNotIn("ghp_", res["message"])


class CapsAndArgsTest(PrCase):
    def test_comment_and_byte_caps(self):
        self.hosts("glab")
        notes = [{"id": i, "author": {"username": "u"}, "created_at": "2026-01-01T00:%02d:%02dZ" % (i // 60, i % 60), "body": "b"} for i in range(250)]
        self.scn({"glab mr view": {"stdout": j({"iid": 3})},
                  "glab api projects/:id/merge_requests/3/discussions?per_page=100": {"stdout": j([{"notes": notes}])}})
        res = self.ok(self.pr("pr_comments"))
        self.assertEqual((res["truncated"], res["total"]), (True, 250))
        self.assertLessEqual(len(res["comments"]), 200)
        self.assertLessEqual(len(json.dumps(res)), safe_ops.MAX_BYTES)
        jobs = [{"name": "n" * 190 + str(i), "status": "failed", "web_url": "u" * 900} for i in range(40)]
        self.scn({"glab mr view": {"stdout": j({"iid": 3, "head_pipeline": {"id": 1}})},
                  "glab api projects/:id/pipelines/1/jobs?per_page=100": {"stdout": j(jobs)}})
        res = self.ok(self.pr("pr_checks"))
        self.assertTrue(res["truncated"] and res["total"] == 40 and len(res["failed"]) < 40, res["total"])
        self.assertLessEqual(len(json.dumps(res)), safe_ops.MAX_BYTES)

    def test_option_like_and_mistyped_args_refused_without_host_call(self):
        self.hosts("gh")
        self.ready()
        for args in ({"title": "--repo=x", "body": "b"}, {"title": "--", "body": "b"}, {"title": "t", "body": "b", "base": "-x"},
                     {"title": "t", "body": "b", "head": "--"}, {"title": "t", "body": "b", "draft": "yes"},
                     {"title": "t\nu", "body": "b"}, {"title": "t", "body": "b", "extra": 1}):
            self.refused(self.pr("pr_create", **args), "bad_request")
        for op in ("pr_status", "pr_checks", "pr_comments"):
            for n in ("1", True, 0, 1.5):
                self.refused(self.pr(op, number=n), "bad_request")
        self.refused(self.pr("pr_comments", since="yesterday"), "bad_request")
        self.assertEqual(self.calls(), [])

    def test_create_refusals_before_the_host(self):
        self.hosts("gh")
        self.ready()
        self.refused(self.pr("pr_create", title="t", body="b", base="feat"), "base_is_head")
        self.refused(self.pr("pr_create", title="t", body="b", head="nope"), "unknown_branch")
        self.git("update-ref", "refs/remotes/origin/feat", "HEAD~1")
        res = self.refused(self.pr("pr_create", title="t", body="b"), "unpushed")
        self.assertIn("differs from its upstream", res["message"])
        self.git("config", "--unset", "branch.feat.merge")
        res = self.refused(self.pr("pr_create", title="t", body="b"), "unpushed")
        self.assertIn("has no upstream", res["message"])
        self.git("checkout", "-q", "--detach")
        self.refused(self.pr("pr_create", title="t", body="b"), "detached_head")
        self.assertEqual(self.calls(), [])


class TemplateTest(PrCase):
    def host(self, **t):
        self.hosts("gh")
        return t

    def test_absent_placeholder_drops_its_option_pair(self):
        h = self.host(checks="gh pr checks --pr {number} --json x")
        self.scn({"gh pr checks": {"stdout": j({"pending": [], "failed": [], "passed": []})}})
        self.ok(self.pr("pr_checks", host=h))
        self.ok(self.pr("pr_checks", host=h, number=5))
        self.assertEqual([c["argv"] for c in self.calls()], [["gh", "pr", "checks", "--json", "x"], ["gh", "pr", "checks", "--pr", "5", "--json", "x"]])

    def test_draft_and_body_file_and_json_answer(self):
        self.ready()
        h = self.host(create="gh pr create --title {title} --body-file {bodyFile} --head {head} --base {base} {draft}")
        self.scn({"gh pr create": {"stdout": j({"number": 3, "url": "https://h.example/3"})}})
        res = self.ok(self.pr("pr_create", host=h, title="a b", body="B", draft=True))
        self.assertEqual((res["number"], res["head"], res["base"]), (3, "feat", self.default))
        self.ok(self.pr("pr_create", host=h, title="a b", body="B"))
        calls = self.calls()
        self.assertEqual((calls[0]["argv"][-1], calls[0]["body"], "--draft" in calls[1]["argv"]), ("--draft", "B", False))
        self.assertEqual(calls[0]["argv"][4], "a b")

    def test_create_text_url_answer(self):
        self.ready()
        h = self.host(create="gh pr create --title {title} --body-file {bodyFile}")
        self.scn({"gh pr create": {"stdout": "note\nhttps://h.example/o/r/pull/21\n"}})
        self.assertEqual(self.ok(self.pr("pr_create", host=h, title="t", body="b"))["number"], 21)

    def test_repo_from_https_and_scp_urls(self):
        h = self.host(status="gh pr view {repo}")
        self.scn({"gh pr view": {"stdout": j(GH_STATUS)}})
        self.git("remote", "add", "origin", "https://user@example.com:8443/own/repo.git")
        self.ok(self.pr("pr_status", host=h))
        self.git("remote", "set-url", "origin", "git@example.com:own/repo.git")
        self.ok(self.pr("pr_status", host=h))
        self.git("remote", "set-url", "origin", "https://example.com/justone")
        self.refused(self.pr("pr_status", host=h), "pr_repo_unknown")
        self.assertEqual([c["argv"][-1] for c in self.calls()], ["own/repo", "own/repo"])

    def test_repo_with_leading_dash_is_refused(self):
        h = self.host(status="gh pr view {repo}")
        self.scn({"gh pr view": {"stdout": j(GH_STATUS)}})
        self.git("remote", "add", "origin", "https://example.com/--output/x")
        self.refused(self.pr("pr_status", host=h), "bad_request")
        self.git("remote", "set-url", "origin", "https://example.com/own/-x")
        self.refused(self.pr("pr_status", host=h), "bad_request")
        self.assertEqual(self.calls(), [])

    def test_exit_codes_and_bad_output(self):
        h = self.host(status="gh pr view")
        self.scn({"gh pr view": {"stderr": "nothing here\n", "exit": 3}})
        self.refused(self.pr("pr_status", host=h), "pr_not_found")
        self.scn({"gh pr view": {"stderr": "log in first\n", "exit": 4}})
        self.assertIn("log in first", self.refused(self.pr("pr_status", host=h), "pr_auth_missing")["message"])
        self.scn({"gh pr view": {"stderr": "bad\n", "exit": 2}})
        self.assertEqual(self.pr("pr_status", host=h)["error"], "pr_host_failed")
        self.scn({"gh pr view": {"stdout": "not json"}})
        res = self.pr("pr_status", host=h)
        self.assertIn("printed no JSON of the documented shape", res["message"])

    def test_missing_template_and_first_word_placeholder(self):
        self.hosts("gh")
        self.refused(self.pr("pr_status", host={"checks": "gh x"}), "pr_host_missing")
        self.refused(self.pr("pr_status", host={"status": "{number} x"}), "pr_template_invalid")

    @unittest.skipIf(os.name == "nt", "builds a POSIX script named like a cmd shim")
    def test_cmd_shim_refuses_unsafe_values(self):
        self.ready()
        d = os.path.join(self.tmp, "cmdbin")
        os.mkdir(d)
        shim = os.path.join(d, "tool.cmd")
        Path(shim).write_text("#!/bin/sh\nexit 0\n", "utf-8")
        os.chmod(shim, 0o755)
        self.use_path(d)
        res = self.refused(self.pr("pr_create", host={"create": "tool.cmd {title}"}, title="a&b", body="x"), "unsafe_for_cmd_shim")
        self.assertIn("use the .exe", res["message"])


def argv_of(call):
    return call["argv"]


def pair(argv, flag):
    return argv[argv.index(flag) + 1]


class CleanTitleTest(unittest.TestCase):
    def test_clean_title_strips_c1_cf_and_cuts(self):
        import pr_ops
        self.assertEqual(pr_ops.clean_title("a\x85b\u202ec\u200bd\x1be\x07f"), "abcdef")
        self.assertEqual(len(pr_ops.clean_title("x" * 500)), 200)
        self.assertEqual(pr_ops.clean_title(None), "")


class RepoLessCase(PrCase):
    """Ops that need no work tree run with any existing directory as cwd."""

    def setUp(self):
        super().setUp()
        self.hosts("gh")
        self.plain = os.path.join(self.tmp, "plain")
        os.mkdir(self.plain)

    def at(self, op, cwd=None, prhost="auto", **args):
        return safe_ops.handle({"op": op, "args": args, "cwd": cwd or self.plain, "config": {"prHost": prhost}})


class GhRepoOpsTest(PrCase):
    def setUp(self):
        super().setUp()
        self.hosts("gh")

    def pr(self, op, **args):  # `host` here is the request's host argument, not tools.prHost
        return safe_ops.handle({"op": op, "args": args, "cwd": self.repo, "config": {"prHost": "auto"}})

    def test_pr_repo_answers_host_repo_url(self):
        self.scn({"gh repo view": {"stdout": j({"nameWithOwner": "acme/lib", "url": "https://ghe.example.com/acme/lib"})}})
        res = self.ok(self.pr("pr_repo"))
        self.assertEqual((res["host"], res["repo"], res["url"]), ("ghe.example.com", "acme/lib", "https://ghe.example.com/acme/lib"))
        self.assertEqual(argv_of(self.calls()[0]), ["gh", "repo", "view", "--json", "nameWithOwner,url"])
        self.scn({"gh repo view": {"stdout": j({"nameWithOwner": "-x/y", "url": "https://github.com/-x/y"})}})
        self.assertEqual(self.pr("pr_repo")["error"], "pr_host_failed")

    def test_pr_status_with_repo_and_host_and_title(self):
        self.scn({"gh pr view 7": {"stdout": j({**GH_STATUS, "title": "t\u202e\x85itle"})}})
        res = self.ok(self.pr("pr_status", number=7, repo="acme/lib", host="ghe.example.com"))
        self.assertEqual(res["title"], "title")
        argv = argv_of(self.calls()[0])
        self.assertEqual(pair(argv, "-R"), "ghe.example.com/acme/lib")
        self.assertIn("number,url,title,state", pair(argv, "--json"))
        self.ok(self.pr("pr_status", number=7, repo="acme/lib"))
        self.assertEqual(pair(argv_of(self.calls()[1]), "-R"), "acme/lib")

    def test_repo_host_author_validation_refuses_before_the_host(self):
        for args in ({"repo": "-x/y"}, {"repo": "a/.."}, {"repo": "./b"}, {"repo": "one"}, {"repo": 5}, {"host": "x.example.com"}, {"repo": "a/b", "host": "-h"}, {"repo": "a/b", "host": "bad host"}):
            self.failed(self.pr("pr_status", **args), "bad_request")
        self.failed(self.pr("pr_find", author="-x"), "bad_request")
        self.failed(self.pr("pr_find", author="a b"), "bad_request")
        self.assertEqual(self.calls(), [])

    def test_checks_required_flag_and_empty_answer(self):
        self.scn({"gh pr checks": {"stdout": j(GH_CHECKS), "exit": 8}})
        res = self.ok(self.pr("pr_checks", number=5, required=True, repo="acme/lib"))
        argv = argv_of(self.calls()[0])
        self.assertIn("--required", argv)
        self.assertEqual(pair(argv, "-R"), "acme/lib")
        self.assertTrue(res["required"])
        self.assertFalse(self.ok(self.pr("pr_checks", number=5))["required"])
        self.assertNotIn("--required", argv_of(self.calls()[1]))
        self.scn({"gh pr checks": {"stderr": "no required checks reported on the 'x' branch\n", "exit": 1}})
        res = self.ok(self.pr("pr_checks", required=True))
        self.assertEqual((res["passed"], res["total"], res["required"]), ([], 0, True))
        self.failed(self.pr("pr_checks", required="yes"), "bad_request")

    def test_comments_keep_pr_view_dash_r_and_make_only_the_inline_path_explicit(self):
        self.scn({"gh pr view 5": {"stdout": j({"comments": [], "reviews": []})}, "gh api": {"stdout": "[]"}})
        self.ok(self.pr("pr_comments", number=5, repo="acme/lib", host="ghe.example.com"))
        view, api = (argv_of(c) for c in self.calls())
        self.assertEqual(view[:4], ["gh", "pr", "view", "5"])
        self.assertEqual(pair(view, "-R"), "ghe.example.com/acme/lib")
        self.assertEqual(api[:4], ["gh", "api", "--method", "GET"])
        self.assertEqual(pair(api, "--hostname"), "ghe.example.com")
        self.assertEqual(api[-1], "repos/acme/lib/pulls/5/comments?per_page=100")
        self.ok(self.pr("pr_comments", number=5, repo="acme/lib"))
        api = argv_of(self.calls()[3])
        self.assertNotIn("--hostname", api)
        self.assertEqual(api[-1], "repos/acme/lib/pulls/5/comments?per_page=100")
        self.ok(self.pr("pr_comments", number=5))
        self.assertEqual(argv_of(self.calls()[5])[-1], "repos/{owner}/{repo}/pulls/5/comments?per_page=100")

    def test_find_by_head_with_state_all_and_host_repo(self):
        found = [{"number": 4, "url": "https://ghe.example.com/acme/lib/pull/4", "state": "MERGED", "title": "t\x85",
                  "headRefName": "feat", "author": {"login": "ci-bot"}}]
        self.scn({"gh pr list": {"stdout": j(found)}})
        res = self.ok(self.pr("pr_find", head="feat", state="all", repo="acme/lib", host="ghe.example.com"))
        self.assertEqual(res["prs"], [{"number": 4, "url": found[0]["url"], "state": "merged", "title": "t", "headRefName": "feat", "author": "ci-bot"}])
        self.assertEqual((res["truncated"], res["total"]), (False, 1))
        argv = argv_of(self.calls()[0])
        self.assertEqual((pair(argv, "-R"), pair(argv, "--head"), pair(argv, "--state")), ("ghe.example.com/acme/lib", "feat", "all"))
        self.assertEqual(pair(argv, "--json"), "number,url,state,title,headRefName,author")

    def test_find_by_author_default_state_open_and_exactly_one_selector(self):
        self.scn({"gh pr list": {"stdout": "[]"}})
        self.ok(self.pr("pr_find", author="@me"))
        argv = argv_of(self.calls()[0])
        self.assertEqual((pair(argv, "--author"), pair(argv, "--state")), ("@me", "open"))
        self.failed(self.pr("pr_find"), "bad_request")
        self.failed(self.pr("pr_find", head="a", author="b"), "bad_request")
        self.failed(self.pr("pr_find", head="a", state="merged"), "bad_request")
        self.failed(self.pr("pr_find", head="-a"), "bad_request")

    def test_find_caps_at_50(self):
        items = [{"number": i + 1, "url": "https://github.com/o/r/pull/%d" % (i + 1), "state": "OPEN", "title": "t", "headRefName": "b%d" % i, "author": {"login": "u"}} for i in range(60)]
        self.scn({"gh pr list": {"stdout": j(items)}})
        res = self.ok(self.pr("pr_find", author="u"))
        self.assertEqual((len(res["prs"]), res["truncated"]), (50, True))


class GlabRepoOpsTest(PrCase):
    def setUp(self):
        super().setUp()
        self.hosts("glab")

    def pr(self, op, **args):  # `host` here is the request's host argument, not tools.prHost
        return safe_ops.handle({"op": op, "args": args, "cwd": self.repo, "config": {"prHost": "auto"}})

    def test_pr_repo(self):
        self.scn({"glab repo view": {"stdout": j({"path_with_namespace": "grp/proj", "web_url": "https://gitlab.example.com/grp/proj"})}})
        res = self.ok(self.pr("pr_repo"))
        self.assertEqual((res["host"], res["repo"]), ("gitlab.example.com", "grp/proj"))
        self.assertEqual(argv_of(self.calls()[0]), ["glab", "repo", "view", "--output", "json"])

    def test_find_uses_source_branch_and_all(self):
        mr = [{"iid": 3, "web_url": "https://gitlab.example.com/grp/proj/-/merge_requests/3", "state": "merged", "title": "t", "source_branch": "feat", "author": {"username": "u"}}]
        self.scn({"glab mr list": {"stdout": j(mr)}})
        res = self.ok(self.pr("pr_find", head="feat", state="all", repo="grp/proj"))
        argv = argv_of(self.calls()[0])
        self.assertEqual((pair(argv, "--source-branch"), pair(argv, "-R")), ("feat", "grp/proj"))
        self.assertIn("--all", argv)
        self.assertEqual((res["prs"][0]["number"], res["prs"][0]["headRefName"], res["prs"][0]["author"], res["prs"][0]["state"]), (3, "feat", "u", "merged"))
        self.ok(self.pr("pr_find", author="u"))
        argv = argv_of(self.calls()[1])
        self.assertNotIn("--all", argv)
        self.assertEqual(pair(argv, "--author"), "u")

    def test_foreign_host_is_refused(self):
        self.assertEqual(self.pr("pr_status", number=3, repo="grp/proj", host="other.example.com")["error"], "pr_host_failed")
        self.assertEqual(self.calls(), [])

    def test_checks_and_comments_use_explicit_project_paths(self):
        jobs = [{"name": "j1", "status": "success"}]
        self.scn({"glab mr view": {"stdout": j({"iid": 3, "head_pipeline": {"id": 9}})},
                  "glab api projects/grp%2Fproj/pipelines/9/jobs?per_page=100": {"stdout": j(jobs)},
                  "glab api projects/grp%2Fproj/merge_requests/3/discussions?per_page=100": {"stdout": "[]"}})
        self.assertEqual([e["name"] for e in self.ok(self.pr("pr_checks", number=3, repo="grp/proj"))["passed"]], ["j1"])
        self.assertEqual(pair(argv_of(self.calls()[0]), "-R"), "grp/proj")
        self.ok(self.pr("pr_comments", number=3, repo="grp/proj"))
        self.assertEqual(argv_of(self.calls()[-1])[-1], "projects/grp%2Fproj/merge_requests/3/discussions?per_page=100")

    def test_batch_search_poll_login_are_unsupported(self):
        for op, args in (("pr_batch", {"prs": [{"repo": "a/b", "n": 1}]}), ("pr_search", {"author": "u"}),
                         ("pr_poll", {"endpoint": "notifications"}), ("pr_login", {})):
            self.failed(self.pr(op, **args), "pr_unsupported")
        self.assertEqual(self.calls(), [])


class SearchTest(RepoLessCase):
    def test_author_and_review_requested_argv(self):
        found = [{"number": 9, "title": "t\x85", "url": "https://github.com/acme/web/pull/9", "repository": {"nameWithOwner": "acme/web", "name": "web"}},
                 {"number": 10, "title": "bad", "url": "http://plain/10", "repository": {"nameWithOwner": "acme/web"}}]
        self.scn({"gh search prs": {"stdout": j(found)}})
        res = self.ok(self.at("pr_search", author="ci-bot"))
        self.assertEqual(res["prs"], [{"number": 9, "url": found[0]["url"], "title": "t", "repository": "acme/web"}])
        argv = argv_of(self.calls()[0])
        self.assertEqual(argv[:6], ["gh", "search", "prs", "--state", "open", "--limit"])
        self.assertEqual((pair(argv, "--author"), pair(argv, "--json")), ("ci-bot", "number,title,url,repository"))
        self.ok(self.at("pr_search", reviewRequested=True))
        self.assertEqual(pair(argv_of(self.calls()[1]), "--review-requested"), "@me")

    def test_validation(self):
        for args in ({}, {"author": "a", "reviewRequested": True}, {"author": "-a"}, {"author": "a b"}, {"reviewRequested": "-x"}, {"author": "a", "host": "x.example.com"}):
            self.failed(self.at("pr_search", **args), "bad_request")
        self.assertEqual(self.calls(), [])

    def test_runs_in_a_directory_that_is_no_repository(self):
        self.scn({"gh search prs": {"stdout": "[]"}})
        self.assertEqual(self.ok(self.at("pr_search", author="u"))["prs"], [])
        self.assertEqual(self.at("pr_search", cwd=os.path.join(self.tmp, "missing"), author="u")["precondition"], "bad_request")

    def test_template_search_contract(self):
        h = {"search": "gh x {author} --host {host}"}
        out = [{"number": 1, "url": "https://h.example/1", "title": "t", "repository": "a/b", "reviewRequested": True},
               {"number": 2, "url": "https://h.example/2", "title": "u"}]
        self.scn({"gh x": {"stdout": j(out)}})
        res = self.ok(self.at("pr_search", prhost=h, author="u", host="h.example"))
        self.assertEqual([(p["number"], p.get("reviewRequested")) for p in res["prs"]], [(1, True), (2, None)])
        self.assertEqual(argv_of(self.calls()[0]), ["gh", "x", "u", "--host", "h.example"])


def rollup(*nodes, total=None):
    return {"state": "PENDING", "contexts": {"totalCount": len(nodes) if total is None else total, "nodes": list(nodes)}}


def gql_pr(n, roll, **kw):
    pr = {"number": n, "url": "https://github.com/acme/lib/pull/%d" % n, "title": "T\x85%d" % n, "state": "OPEN", "isDraft": False,
          "mergeable": "MERGEABLE", "reviewDecision": "APPROVED", "headRefName": "feat",
          "commits": {"nodes": [{"commit": {"statusCheckRollup": roll}}]}}
    pr.update(kw)
    return {"pullRequest": pr}


def run(name, status="COMPLETED", conclusion="SUCCESS", started="2026-01-01T00:00:00Z", required=False):
    return {"__typename": "CheckRun", "name": name, "status": status, "conclusion": conclusion, "startedAt": started, "isRequired": required}


def status(name, state):
    return {"__typename": "StatusContext", "context": name, "state": state, "isRequired": False}


class BatchTest(RepoLessCase):
    def test_variables_aliases_and_no_interpolation(self):
        self.scn({"gh api graphql": {"stdout": j({"data": {"r0": gql_pr(5, rollup()), "r1": gql_pr(6, rollup())}})}})
        res = self.ok(self.at("pr_batch", prs=[{"repo": "acme/lib", "n": 5}, {"repo": "Other/Tool.x", "n": 6}]))
        self.assertEqual([p["number"] for p in res["prs"]], [5, 6])
        argv = argv_of(self.calls()[0])
        self.assertEqual(argv[:4], ["gh", "api", "graphql", "-f"])
        pairs = [(argv[i], argv[i + 1]) for i in range(len(argv) - 1) if argv[i] in ("-f", "-F")]
        self.assertIn(("-f", "owner0=acme"), pairs)
        self.assertIn(("-f", "name0=lib"), pairs)
        self.assertIn(("-F", "n0=5"), pairs)
        self.assertIn(("-f", "owner1=Other"), pairs)
        self.assertIn(("-f", "name1=Tool.x"), pairs)
        self.assertIn(("-F", "n1=6"), pairs)
        self.assertEqual([k for k, v in pairs if v.startswith(("owner", "name"))], ["-f"] * 4)
        query = [v for k, v in pairs if v.startswith("query=")][0]
        for frag in ("$owner0: String!", "$name1: String!", "$n1: Int!", "r1: repository(owner: $owner1, name: $name1)", "pullRequest(number: $n0)",
                     "isRequired(pullRequestNumber: $n0)", "contexts(first: 100)", "totalCount"):
            self.assertIn(frag, query)
        for lit in ("acme", "Tool.x"):
            self.assertNotIn(lit, query)
        self.ok(self.at("pr_batch", prs=[{"repo": "acme/lib", "n": 5}]))
        self.assertNotIn("--hostname", argv_of(self.calls()[1]))

    def test_hostname_and_validation_and_cap(self):
        self.scn({"gh api graphql": {"stdout": j({"data": {"r0": gql_pr(5, rollup())}})}})
        self.ok(self.at("pr_batch", host="ghe.example.com", prs=[{"repo": "acme/lib", "n": 5}]))
        self.assertEqual(pair(argv_of(self.calls()[0]), "--hostname"), "ghe.example.com")
        many = lambda k: [{"repo": "acme/lib", "n": i + 1} for i in range(k)]
        self.failed(self.at("pr_batch", prs=many(51)), "bad_request")
        self.failed(self.at("pr_batch", prs=[]), "bad_request")
        for bad in ({"repo": "-x/y", "n": 1}, {"repo": "a/..", "n": 1}, {"repo": "a/b/c", "n": 1}, {"repo": "a/b", "n": 0}, {"repo": "a/b", "n": True}, {"repo": "a/b"}, {"repo": "a/b", "n": 1, "x": 1}):
            self.failed(self.at("pr_batch", prs=[bad]), "bad_request")
        self.assertEqual(len(self.calls()), 1)
        self.scn({"gh api graphql": {"stdout": j({"data": {"r%d" % i: gql_pr(i + 1, rollup()) for i in range(50)}})}})
        self.assertEqual(len(self.ok(self.at("pr_batch", prs=many(50)))["prs"]), 50)

    def test_mapping_exclusive_groups_and_truncation(self):
        nodes = [run("f1", conclusion="FAILURE"), run("f2", conclusion="TIMED_OUT"), run("f3", conclusion="CANCELLED"),
                 run("f4", conclusion="ACTION_REQUIRED"), run("f5", conclusion="STARTUP_FAILURE"),
                 run("m1", status="QUEUED", conclusion=None, started=None, required=True),
                 run("m2", status="QUEUED", conclusion=None, started="0001-01-01T00:00:00Z", required=True),
                 run("p1", status="IN_PROGRESS", conclusion=None, required=True),
                 run("p2", status="QUEUED", conclusion=None, started=None, required=False),
                 run("ok1"), run("ok2", conclusion="SKIPPED"),
                 status("s-fail", "FAILURE"), status("s-err", "ERROR"), status("s-exp", "EXPECTED"), status("s-pend", "PENDING"), status("s-ok", "SUCCESS")]
        self.scn({"gh api graphql": {"stdout": j({"data": {"r0": gql_pr(5, rollup(*nodes, total=101), mergeable="CONFLICTING", state="MERGED", reviewDecision="CHANGES_REQUESTED")}})}})
        res = self.ok(self.at("pr_batch", prs=[{"repo": "acme/lib", "n": 5}]))
        pr = res["prs"][0]
        c = pr["checks"]
        self.assertEqual(c["failed"], ["f1", "f2", "f3", "f4", "f5", "s-fail", "s-err"])
        self.assertEqual(c["missing"], ["m1", "m2", "s-exp"])
        self.assertEqual(c["pending"], ["p1", "p2", "s-pend"])
        self.assertEqual(c["passed"], ["ok1", "ok2", "s-ok"])
        self.assertEqual(c["counts"], {"failed": 7, "missing": 3, "pending": 3, "passed": 3})
        self.assertTrue(c["truncated"])
        self.assertEqual((pr["state"], pr["mergeable"], pr["reviewDecision"], pr["draft"], pr["title"], pr["headRefName"]), ("merged", "conflicting", "changes_requested", False, "T5", "feat"))
        self.assertEqual((pr["repo"], pr["number"], pr["url"]), ("acme/lib", 5, "https://github.com/acme/lib/pull/5"))
        self.scn({"gh api graphql": {"stdout": j({"data": {"r0": gql_pr(5, rollup(run("a")))}})}})
        self.assertFalse(self.ok(self.at("pr_batch", prs=[{"repo": "acme/lib", "n": 5}]))["prs"][0]["checks"]["truncated"])

    def test_name_lists_are_capped_but_counts_stay(self):
        nodes = [run("c%d" % i) for i in range(15)]
        self.scn({"gh api graphql": {"stdout": j({"data": {"r0": gql_pr(5, rollup(*nodes))}})}})
        c = self.ok(self.at("pr_batch", prs=[{"repo": "acme/lib", "n": 5}]))["prs"][0]["checks"]
        self.assertEqual((len(c["passed"]), c["counts"]["passed"]), (10, 15))

    def test_per_pr_errors_with_gh_exit_1_and_partial_data(self):
        out = {"data": {"r0": gql_pr(5, rollup()), "r1": {"pullRequest": None}, "r2": None},
               "errors": [{"type": "NOT_FOUND", "path": ["r1", "pullRequest"], "message": "x"},
                          {"type": "FORBIDDEN", "path": ["r2"], "message": "SAML"}]}
        self.scn({"gh api graphql": {"stdout": j(out), "stderr": "gh: Could not resolve\n", "exit": 1}})
        res = self.ok(self.at("pr_batch", prs=[{"repo": "acme/lib", "n": 5}, {"repo": "acme/lib", "n": 6}, {"repo": "acme/priv", "n": 7}]))
        self.assertEqual([p["number"] for p in res["prs"]], [5])
        self.assertEqual(res["errors"], [{"repo": "acme/lib", "number": 6, "kind": "pr_not_found"}, {"repo": "acme/priv", "number": 7, "kind": "pr_host_failed"}])

    def test_rate_limited_and_unparseable_fail_the_call(self):
        rl = {"data": None, "errors": [{"type": "RATE_LIMITED", "message": "API rate limit exceeded"}]}
        self.scn({"gh api graphql": {"stdout": j(rl), "exit": 1}})
        res = self.at("pr_batch", prs=[{"repo": "acme/lib", "n": 5}])
        self.assertEqual(res["error"], "pr_host_failed")
        self.assertIn("RATE_LIMITED", res["message"])
        self.scn({"gh api graphql": {"stdout": "", "stderr": "gh: HTTP 502\n", "exit": 1}})
        self.assertEqual(self.at("pr_batch", prs=[{"repo": "acme/lib", "n": 5}])["error"], "pr_host_failed")
        self.scn({"gh api graphql": {"stdout": "<html>", "exit": 0}})
        self.assertEqual(self.at("pr_batch", prs=[{"repo": "acme/lib", "n": 5}])["error"], "pr_host_failed")

    def test_templates_are_unsupported(self):
        self.failed(self.at("pr_batch", prhost={"status": "gh pr view"}, prs=[{"repo": "a/b", "n": 1}]), "pr_unsupported")
        self.assertEqual(self.calls(), [])


NOTIFS = [
    {"reason": "review_requested", "subject": {"type": "PullRequest", "title": "R\x85", "url": "https://api.ghe.example.com/repos/acme/lib/pulls/7"},
     "repository": {"full_name": "acme/lib", "html_url": "https://ghe.example.com/acme/lib"}},
    {"reason": "mention", "subject": {"type": "PullRequest", "title": "x", "url": "https://api.github.com/repos/acme/lib/pulls/8"},
     "repository": {"full_name": "acme/lib", "html_url": "https://github.com/acme/lib"}},
    {"reason": "review_requested", "subject": {"type": "Issue", "title": "x", "url": "https://api.github.com/repos/acme/lib/issues/9"},
     "repository": {"full_name": "acme/lib", "html_url": "https://github.com/acme/lib"}},
]
EVENTS = [
    {"type": "PullRequestEvent", "repo": {"name": "acme/lib"}, "created_at": "2026-01-02T00:00:00Z", "payload": {"number": 3, "pull_request": {"number": 3, "html_url": "https://ghe.example.com/acme/lib/pull/3"}}},
    {"type": "IssueCommentEvent", "repo": {"name": "acme/lib"}, "created_at": "2026-01-02T01:00:00Z", "payload": {"issue": {"number": 4, "pull_request": {"url": "u"}}}},
    {"type": "IssueCommentEvent", "repo": {"name": "acme/lib"}, "created_at": "2026-01-02T02:00:00Z", "payload": {"issue": {"number": 5}}},
    {"type": "PushEvent", "repo": {"name": "acme/lib"}, "created_at": "2026-01-02T03:00:00Z", "payload": {}},
    {"type": "PullRequestReviewEvent", "repo": {"name": "-x/y"}, "created_at": "2026-01-02T04:00:00Z", "payload": {"pull_request": {"number": 6}}},
]


def http(status, headers, body=""):
    return "HTTP/2.0 %s X\r\n%s\r\n\r\n%s" % (status, "\r\n".join("%s: %s" % kv for kv in headers.items()), body)


class PollTest(RepoLessCase):
    def test_notifications_200_conditional_headers_and_reduction(self):
        self.scn({"gh api -i": {"stdout": http(200, {"Last-Modified": "Sat, 31 Jan 2026 12:00:00 GMT", "ETag": 'W/"abc"', "X-Poll-Interval": "60"}, j(NOTIFS))}})
        res = self.ok(self.at("pr_poll", endpoint="notifications", since="Fri, 30 Jan 2026 12:00:00 GMT", page=2, host="ghe.example.com"))
        self.assertEqual((res["status"], res["lastModified"], res["etag"], res["pollInterval"]), (200, "Sat, 31 Jan 2026 12:00:00 GMT", 'W/"abc"', 60))
        self.assertEqual(res["items"], [{"repo": "acme/lib", "n": 7, "title": "R", "url": "https://ghe.example.com/acme/lib/pull/7"}])
        argv = argv_of(self.calls()[0])
        self.assertEqual(argv[:6], ["gh", "api", "-i", "--method", "GET", "--hostname"])
        self.assertEqual(argv[-1], "notifications?all=false&participating=false&per_page=100&page=2")
        self.assertEqual(pair(argv, "-H"), "If-Modified-Since: Fri, 30 Jan 2026 12:00:00 GMT")
        self.assertNotIn("If-None-Match", " ".join(argv))

    def test_events_200_etag_header_and_reduction(self):
        self.scn({"gh api -i": {"stdout": http(200, {"ETag": '"e1"'}, j(EVENTS))}})
        res = self.ok(self.at("pr_poll", endpoint="events", login="octo-user", etag='W/"e0"'))
        argv = argv_of(self.calls()[0])
        self.assertEqual(argv[-1], "users/octo-user/events?per_page=100")
        self.assertEqual(pair(argv, "-H"), 'If-None-Match: W/"e0"')
        self.assertEqual(res["etag"], '"e1"')
        self.assertEqual(res["items"], [
            {"repo": "acme/lib", "n": 3, "url": "https://ghe.example.com/acme/lib/pull/3", "at": "2026-01-02T00:00:00Z"},
            {"repo": "acme/lib", "n": 4, "url": "https://github.com/acme/lib/pull/4", "at": "2026-01-02T01:00:00Z"}])

    def test_304_403_404_with_gh_exit_1_are_answers(self):
        for code in (304, 403, 404):
            self.scn({"gh api -i": {"stdout": http(code, {"ETag": '"e"'}), "stderr": "gh: HTTP %d\n" % code, "exit": 1}})
            res = self.ok(self.at("pr_poll", endpoint="events", login="u"))
            self.assertEqual((res["status"], res["items"]), (code, None))
        self.scn({"gh api -i": {"stdout": "", "stderr": "gh: not logged in\n", "exit": 4}})
        self.failed(self.at("pr_poll", endpoint="events", login="u"), "pr_auth_missing")
        self.scn({"gh api -i": {"stdout": "garbage", "exit": 0}})
        self.assertEqual(self.at("pr_poll", endpoint="events", login="u")["error"], "pr_host_failed")

    def test_validation(self):
        ok_since = "Sat, 31 Jan 2026 12:00:00 GMT"
        bad = [{"endpoint": "other"}, {"endpoint": "notifications", "since": "2026-01-31T12:00:00Z"},
               {"endpoint": "notifications", "since": ok_since + "\nX: y"}, {"endpoint": "notifications", "etag": "abc"},
               {"endpoint": "notifications", "etag": '"a\nb"'}, {"endpoint": "notifications", "page": 0}, {"endpoint": "notifications", "page": 4},
               {"endpoint": "notifications", "page": True}, {"endpoint": "notifications", "login": "u"},
               {"endpoint": "events"}, {"endpoint": "events", "login": "-u"}, {"endpoint": "events", "login": "a/b"},
               {"endpoint": "events", "login": "u", "page": 1}, {"endpoint": "events", "login": "u", "host": "-h"}]
        for args in bad:
            self.failed(self.at("pr_poll", **args), "bad_request")
        self.assertEqual(self.calls(), [])
        self.scn({"gh api -i": {"stdout": http(304, {})}})
        self.ok(self.at("pr_poll", endpoint="notifications", since=ok_since, etag='"x"'))
        self.assertEqual([a for a in argv_of(self.calls()[0]) if a.startswith("If-")], ["If-Modified-Since: " + ok_since, 'If-None-Match: "x"'])

    def test_item_cap_200(self):
        many = [{"reason": "review_requested", "subject": {"type": "PullRequest", "title": "t", "url": "https://api.github.com/repos/a/b/pulls/%d" % (i + 1)},
                 "repository": {"full_name": "a/b", "html_url": "https://github.com/a/b"}} for i in range(260)]
        self.scn({"gh api -i": {"stdout": http(200, {}, j(many))}})
        self.assertEqual(len(self.ok(self.at("pr_poll", endpoint="notifications"))["items"]), 200)

    def test_byte_cap_64k(self):
        full = "o" * 39 + "/" + "r" * 100
        many = [{"reason": "review_requested", "subject": {"type": "PullRequest", "title": "t" * 900, "url": "https://api.github.com/repos/%s/pulls/%d" % (full, i + 1)},
                 "repository": {"full_name": full, "html_url": "https://github.com/" + full}} for i in range(260)]
        self.scn({"gh api -i": {"stdout": http(200, {}, j(many))}})
        res = self.ok(self.at("pr_poll", endpoint="notifications"))
        self.assertLess(len(j({k: v for k, v in res.items() if k != "ok"})), 64 * 1024 + 200)
        self.assertLess(len(res["items"]), 200)


class LoginTest(RepoLessCase):
    def test_login(self):
        self.scn({"gh api": {"stdout": "octo-user\n"}})
        self.assertEqual(self.ok(self.at("pr_login"))["login"], "octo-user")
        self.assertEqual(argv_of(self.calls()[0]), ["gh", "api", "user", "--jq", ".login"])
        self.ok(self.at("pr_login", host="ghe.example.com"))
        self.assertEqual(pair(argv_of(self.calls()[1]), "--hostname"), "ghe.example.com")
        self.scn({"gh api": {"stdout": "-evil\n"}})
        self.assertEqual(self.at("pr_login")["error"], "pr_host_failed")


class FindTemplateTest(PrCase):
    def test_find_template_contract_with_mode_and_state(self):
        self.hosts("gh")
        self.ready()
        h = {"find": "gh x {mode} {head} {author} --state {state} -R {repo} --host {host}"}
        out = [{"number": 4, "url": "https://h.example/o/r/pull/4", "state": "open", "title": "t\x85", "headRefName": "feat", "author": "u"}]
        self.scn({"gh x": {"stdout": j(out)}})
        res = self.ok(safe_ops.handle({"op": "pr_find", "args": {"head": "feat", "state": "all", "repo": "o/r", "host": "h.example"},
                                       "cwd": self.repo, "config": {"prHost": h}}))
        self.assertEqual(argv_of(self.calls()[0]), ["gh", "x", "head", "feat", "--state", "all", "-R", "o/r", "--host", "h.example"])
        self.assertEqual((res["prs"][0]["title"], res["prs"][0]["headRefName"]), ("t", "feat"))
        self.ok(safe_ops.handle({"op": "pr_find", "args": {"author": "u"}, "cwd": self.repo, "config": {"prHost": h}}))
        self.assertEqual(argv_of(self.calls()[1])[:4], ["gh", "x", "author", "u"])


class ReplessSetTest(unittest.TestCase):
    def test_repoless_ops_are_pr_ops(self):
        self.assertEqual(set(safe_ops.REPOLESS_PR_OPS), {"pr_search", "pr_batch", "pr_poll", "pr_login"})
        self.assertTrue(set(safe_ops.REPOLESS_PR_OPS) <= set(safe_ops.PR_OPS))
        for op in ("pr_repo", "pr_find"):
            self.assertIn(op, safe_ops.PR_OPS)
            self.assertNotIn(op, safe_ops.REPOLESS_PR_OPS)


if __name__ == "__main__":
    unittest.main()
