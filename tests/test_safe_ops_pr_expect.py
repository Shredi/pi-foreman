"""pr_batch (watch): the expected checks. Which of a head's checks count as expected (started by the pull request itself or its push, another CI app's,
a status context), the baseline of the newest merged pull requests into the base, the error and cut markers, and the retries."""
import itertools
import json
import unittest
from unittest import mock

import test_safe_ops_pr as prt
import pr_ops

IDS = itertools.count(1)
MERGE = "2026-01-02T00:00:00Z"
BEFORE = "2026-01-01T23:00:00Z"
AFTER = "2026-01-02T00:00:05Z"
ENTRY = {"repo": "acme/lib", "n": 5}
FLAGGED = dict(ENTRY, baseline=True)


def ck(name, event="pull_request", app="github-actions", started=BEFORE):
    nd = dict(prt.run(name, started=started), databaseId=next(IDS))
    nd["checkSuite"] = {"app": {"slug": app} if app else None, "workflowRun": {"event": event} if event else None}
    return nd


def ctx(name, created=BEFORE):
    return {"__typename": "StatusContext", "context": name, "state": "SUCCESS", "createdAt": created}


def merged(base, at, *nodes):
    return {"baseRefName": base, "mergedAt": at, "commits": {"nodes": [{"commit": {"statusCheckRollup": prt.rollup(*nodes)}}]}}


def answer(own=(), nodes=(), errors=None, **kw):
    pr = prt.gql_pr(5, prt.rollup(*own), headRefOid="abc1234567", baseRefName="main", updatedAt="2026-01-02T00:00:00Z", **kw)
    out = {"data": {"r0": dict(pr, merged={"nodes": list(nodes)})}}
    if errors:
        out["errors"] = errors
    return out


class ExpectBatchTest(prt.RepoLessCase):
    def batch(self, resp, entry=FLAGGED):
        self.scn({"gh api graphql": {"stdout": prt.j(resp)}})
        return self.ok(self.at("pr_batch", prs=[entry], watch=True))["prs"][0]

    def names(self, *nodes, base="main", at=MERGE):
        return self.batch(answer(nodes=[merged(base, at, *nodes)]))["baseline"]["names"]

    def query(self, n=0):
        return json.loads(self.calls()[n]["body"])["query"]

    def test_without_the_flag_the_merged_field_is_not_asked_and_the_row_has_no_baseline(self):
        got = self.batch(answer(), ENTRY)
        self.assertNotIn("baseline", got)
        self.assertNotIn("merged: pullRequests", self.query())

    def test_with_the_flag_the_merged_field_is_asked_and_the_row_carries_the_names(self):
        got = self.batch(answer(nodes=[merged("main", MERGE, ck("build"))]))
        self.assertIn("merged: pullRequests(states: MERGED", self.query())
        self.assertEqual(got["baseline"], {"names": ["build"], "learn": {"ran": ["build"], "merged": 1}})

    def test_the_flag_must_be_a_boolean(self):
        self.scn({"gh api graphql": {"stdout": prt.j(answer())}})
        self.refused(self.at("pr_batch", prs=[dict(ENTRY, baseline="yes")], watch=True), "bad_request")

    def test_an_old_merge_with_a_newer_update_time_does_not_win_and_another_base_is_ignored(self):
        nodes = [merged("main", "2026-01-01T00:00:00Z", ck("old-check")), merged("main", "2026-01-05T00:00:00Z", ck("a")),
                 merged("main", "2026-01-04T00:00:00Z", ck("b")), merged("main", "2026-01-03T00:00:00Z", ck("c")),
                 merged("release", "2026-01-09T00:00:00Z", ck("other-base"))]
        self.assertEqual(self.batch(answer(nodes=nodes))["baseline"]["names"], ["a", "b", "c"])

    def test_the_newest_three_are_united_and_a_docs_only_newest_merge_does_not_empty_the_set(self):
        nodes = [merged("main", "2026-01-05T00:00:00Z"), merged("main", "2026-01-04T00:00:00Z", ck("a"), ck("shared")),
                 merged("main", "2026-01-03T00:00:00Z", ck("b"), ck("shared")), merged("main", "2026-01-02T00:00:00Z", ck("fourth"))]
        self.assertEqual(self.batch(answer(nodes=nodes))["baseline"]["names"], ["a", "shared", "b"])

    def test_no_merged_pull_request_with_that_base_is_a_known_empty_baseline(self):
        got = self.batch(answer(nodes=[merged("release", MERGE, ck("a"))]))
        self.assertEqual(got["baseline"], {"names": []})

    def test_which_checks_of_a_merged_head_count(self):
        got = self.names(ck("pr-run"), ck("target-run", event="pull_request_target"), ck("push-run", event="push"),
                         ck("review-run", event="pull_request_review"), ck("comment-run", event="issue_comment"), ck("nightly", event="schedule"),
                         ck("manual", event="workflow_dispatch"), ck("other-app", event=None, app="other-ci"), ctx("status-before"),
                         ctx("status-after", AFTER), ck("close-run", started=AFTER), ck("base-push", event="push", started=AFTER),
                         ck("hidden", event=None), ck("no-app", event="pull_request", app=None))
        self.assertEqual(got, ["pr-run", "target-run", "push-run", "other-app", "status-before"])

    def test_a_workflow_run_error_on_one_check_leaves_a_known_baseline_without_that_run(self):
        path = ["r0", "merged", "nodes", 0, "commits", "nodes", 0, "commit", "statusCheckRollup", "contexts", "nodes", 1, "checkSuite", "workflowRun"]
        resp = answer(nodes=[merged("main", MERGE, ck("fine"), ck("hidden", event=None))], errors=[{"type": "FORBIDDEN", "path": path, "message": "no access"}])
        self.assertEqual(self.batch(resp)["baseline"], {"names": ["fine"]})

    def test_an_error_on_the_merged_list_or_a_merged_head_is_the_error_marker(self):
        for path in (["r0", "merged"], ["r0", "merged", "nodes", 0, "commits"],
                     ["r0", "merged", "nodes", 0, "commits", "nodes", 0, "commit", "statusCheckRollup", "contexts"]):
            resp = answer(nodes=[merged("main", MERGE, ck("a"))], errors=[{"type": "FORBIDDEN", "path": path, "message": "no"}])
            self.assertEqual(self.batch(resp)["baseline"], {"error": True}, path)

    def test_a_missing_merged_list_is_the_error_marker(self):
        resp = answer()
        del resp["data"]["r0"]["merged"]
        self.assertEqual(self.batch(resp)["baseline"], {"error": True})

    def test_the_names_of_a_base_are_cut_to_100(self):
        names = self.names(*[ck("job-%03d" % i) for i in range(130)])
        self.assertEqual(len(names), 100)
        self.assertEqual(names[0], "job-000")

    def test_only_the_flagged_entries_get_a_baseline(self):
        resp = {"data": {"r0": answer(nodes=[merged("main", MERGE, ck("a"))])["data"]["r0"], "r1": prt.gql_pr(6, prt.rollup(), headRefOid="d", baseRefName="main", updatedAt="u")}}
        self.scn({"gh api graphql": {"stdout": prt.j(resp)}})
        prs = self.ok(self.at("pr_batch", prs=[FLAGGED, {"repo": "acme/lib", "n": 6}], watch=True))["prs"]
        self.assertIn("baseline", prs[0])
        self.assertNotIn("baseline", prs[1])
        self.assertEqual(self.query().count("merged: pullRequests"), 1)

    def test_a_run_of_the_head_carries_expected_by_its_event_and_app(self):
        got = self.batch(answer(own=[ck("a"), ck("review-run", event="pull_request_review"), ck("other-app", event=None, app="other-ci"), ctx("status"),
                                     ck("hidden", event=None)]), ENTRY)
        flags = {r["name"]: r.get("expected") for r in got["runs"]}
        self.assertEqual(flags, {"a": True, "review-run": None, "other-app": True, "status": True, "hidden": None})

    def test_the_cut_marker_on_a_cut_run_list_and_none_on_a_whole_one(self):
        self.assertNotIn("cut", self.batch(answer(own=[ck("a")]), ENTRY))
        many = answer(own=[ck("job-%03d-%s" % (i, "x" * 90)) for i in range(150)])
        self.assertIs(self.batch(many, ENTRY)["cut"], True)

    def test_more_checks_than_the_100_read_set_the_cut_marker(self):
        resp = answer(own=[ck("a")])
        resp["data"]["r0"]["pullRequest"]["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]["totalCount"] = 130
        self.assertIs(self.batch(resp, ENTRY)["cut"], True)

    def test_a_rate_limited_batch_with_the_merged_field_is_not_retried(self):
        self.scn({"gh api graphql": {"stdout": prt.j({"errors": [{"type": "RATE_LIMITED", "message": "x"}]}), "exit": 1}})
        self.assertEqual(self.at("pr_batch", prs=[FLAGGED], watch=True)["error"], "pr_host_failed")
        self.assertEqual(len(self.calls()), 1)

    def _fake(self, bad_when, bad, good):
        queries = []

        def fake(argv, root, subst=()):
            with open(argv[argv.index("--input") + 1], encoding="utf-8") as f:
                q = json.load(f)["query"]
            queries.append(q)
            return bad if bad_when(q) else (0, prt.j(good), "")

        return queries, fake

    def test_a_failing_batch_with_the_merged_field_is_asked_again_without_it_and_the_baseline_is_unknown(self):
        queries, fake = self._fake(lambda q: "merged: pullRequests" in q, (1, "", "gh: HTTP 502 Bad Gateway"), answer())
        with mock.patch.object(pr_ops, "run_host", fake):
            got = self.ok(self.at("pr_batch", prs=[FLAGGED], watch=True))["prs"][0]
        self.assertEqual(len(queries), 2)
        self.assertNotIn("merged: pullRequests", queries[1])
        self.assertEqual(got["baseline"], {"error": True})
        self.assertEqual(got["headSha"], "abc1234567")

    def test_a_host_that_rejects_the_merged_field_is_asked_again_without_it_and_the_row_has_no_baseline(self):
        bad = (1, prt.j({"errors": [{"type": "undefinedField", "message": "Field 'pullRequests' doesn't exist on type 'Repository'"}]}), "")
        queries, fake = self._fake(lambda q: "merged: pullRequests" in q, bad, answer())
        with mock.patch.object(pr_ops, "run_host", fake):
            got = self.ok(self.at("pr_batch", prs=[FLAGGED], watch=True))["prs"][0]
        self.assertEqual(len(queries), 2)
        self.assertNotIn("baseline", got)

    def test_a_host_that_rejects_the_per_run_fields_is_asked_again_without_them(self):
        bad = (1, prt.j({"errors": [{"type": "undefinedField", "message": "Field 'workflowRun' doesn't exist on type 'CheckSuite'"}]}), "")
        queries, fake = self._fake(lambda q: "workflowRun" in q, bad, answer(own=[prt.run("a")]))
        with mock.patch.object(pr_ops, "run_host", fake):
            got = self.ok(self.at("pr_batch", prs=[FLAGGED], watch=True))["prs"][0]
        self.assertEqual(len(queries), 2)
        self.assertNotIn("workflowRun", queries[1])
        self.assertNotIn("merged: pullRequests", queries[1])
        self.assertNotIn("baseline", got)
        self.assertNotIn("expected", got["runs"][0])


if __name__ == "__main__":
    unittest.main()
