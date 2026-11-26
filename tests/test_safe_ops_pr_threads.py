"""pr_batch (watch) and pr_status: the open review threads, and the retry on a host that rejects the field."""
import json
import unittest
from unittest import mock

import test_safe_ops_pr as prt
import pr_ops


def thread(body, resolved=False):
    return {"isResolved": resolved, "comments": {"nodes": [{"body": body}]}}


def threads(*nodes, more=False):
    return {"reviewThreads": {"pageInfo": {"hasNextPage": more}, "nodes": list(nodes)}}


def watch_pr(**kw):
    return prt.gql_pr(5, prt.rollup(dict(prt.run("ci"), databaseId=1)), headRefOid="abc1234567", baseRefName="main", updatedAt="2026-01-02T00:00:00Z", **kw)


class ThreadsBatchTest(prt.RepoLessCase):
    def watch(self, pr):
        self.scn({"gh api graphql": {"stdout": prt.j({"data": {"r0": pr}})}})
        return self.ok(self.at("pr_batch", prs=[{"repo": "acme/lib", "n": 5}], watch=True))["prs"][0]

    def test_open_threads_are_counted_with_their_first_lines_and_resolved_ones_are_not(self):
        got = self.watch(watch_pr(**threads(thread("fix this\nsecond line"), thread("done", resolved=True), thread("and this"))))
        self.assertEqual(got["threads"], {"open": 2, "more": False, "lines": ["fix this", "and this"]})
        query = json.loads(self.calls()[0]["body"])["query"]
        for frag in ("reviewThreads(first: 100)", "isResolved", "hasNextPage"):
            self.assertIn(frag, query)

    def test_no_open_thread_or_no_answer_leaves_the_field_out(self):
        self.assertNotIn("threads", self.watch(watch_pr(**threads(thread("done", resolved=True)))))
        self.assertNotIn("threads", self.watch(watch_pr()))

    def test_a_first_page_with_more_pages_says_so(self):
        got = self.watch(watch_pr(**threads(thread("a"), more=True)))
        self.assertEqual(got["threads"]["more"], True)

    def test_a_non_watch_batch_does_not_ask(self):
        self.scn({"gh api graphql": {"stdout": prt.j({"data": {"r0": prt.gql_pr(5, prt.rollup())}})}})
        self.ok(self.at("pr_batch", prs=[{"repo": "acme/lib", "n": 5}]))
        self.assertNotIn("reviewThreads", json.loads(self.calls()[0]["body"])["query"])

    def test_a_host_that_rejects_the_field_is_asked_again_without_it(self):
        bad = {"errors": [{"type": "undefinedField", "message": "Field 'reviewThreads' doesn't exist on type 'PullRequest'"}]}
        good = {"data": {"r0": watch_pr()}}
        queries = []

        def fake(argv, root, subst=()):
            with open(argv[argv.index("--input") + 1], encoding="utf-8") as f:
                q = json.load(f)["query"]
            queries.append(q)
            return (1, prt.j(bad), "") if "reviewThreads" in q else (0, prt.j(good), "")

        with mock.patch.object(pr_ops, "run_host", fake):
            got = self.ok(self.at("pr_batch", prs=[{"repo": "acme/lib", "n": 5}], watch=True))["prs"][0]
        self.assertEqual(len(queries), 2)
        self.assertIn("mergeStateStatus", queries[1])
        self.assertNotIn("threads", got)
        self.assertEqual(got["headSha"], "abc1234567")


class ThreadsStatusTest(prt.RepoLessCase):
    def test_pr_status_carries_the_open_threads(self):
        self.scn({"gh pr view": {"stdout": prt.j(prt.GH_STATUS)},
                  "gh api graphql": {"stdout": prt.j({"data": {"repository": {"pullRequest": threads(thread("please rename"), thread("ok", resolved=True))}}})}})
        res = self.ok(self.pr("pr_status", number=7))
        self.assertEqual(res["openThreads"], {"open": 1, "more": False, "lines": ["please rename"]})
        body = json.loads(self.calls()[1]["body"])
        self.assertEqual(body["variables"], {"owner": "own", "name": "repo", "n": 7})

    def test_pr_status_does_not_fail_when_the_threads_cannot_be_read(self):
        self.scn({"gh pr view": {"stdout": prt.j(prt.GH_STATUS)},
                  "gh api graphql": {"stdout": prt.j({"errors": [{"type": "undefinedField", "message": "Field 'reviewThreads' doesn't exist"}]})}})
        res = self.ok(self.pr("pr_status", number=7))
        self.assertNotIn("openThreads", res)
        self.assertEqual(res["number"], 7)


if __name__ == "__main__":
    unittest.main()
