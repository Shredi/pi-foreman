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


if __name__ == "__main__":
    unittest.main()
