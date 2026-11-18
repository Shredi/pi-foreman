"""pr_batch (watch): the learning list `learn` of a baseline (D101): every check name that ran before the merge on the merged heads read, present only when complete."""
import unittest

import test_safe_ops_pr as prt
import test_safe_ops_pr_expect as ex
from test_safe_ops_pr_expect import AFTER, FLAGGED, MERGE, answer, ck, ctx, merged


class LearnTest(prt.RepoLessCase):
    def batch(self, resp):
        self.scn({"gh api graphql": {"stdout": prt.j(resp)}})
        return self.ok(self.at("pr_batch", prs=[FLAGGED], watch=True))["prs"][0]

    def learn(self, resp):
        return self.batch(resp)["baseline"].get("learn")

    def test_the_list_holds_every_check_that_started_before_the_merge_whatever_its_event(self):
        got = self.learn(answer(nodes=[merged("main", MERGE, ck("pr-run"), ck("review-run", event="pull_request_review"), ck("comment-run", event="issue_comment"),
                                              ck("nightly", event="schedule"), ck("manual", event="workflow_dispatch"), ck("hidden", event=None),
                                              ctx("status-before"), ctx("status-after", AFTER), ck("close-run", started=AFTER))]))
        self.assertEqual(got, {"ran": ["pr-run", "review-run", "comment-run", "nightly", "manual", "hidden", "status-before"], "merged": 1})

    def test_a_merge_group_run_an_expected_context_and_a_never_started_run_are_left_out(self):
        expected = {"__typename": "StatusContext", "context": "gate", "state": "EXPECTED", "createdAt": ex.BEFORE}
        never = dict(prt.run("never", status="QUEUED", conclusion=None, started=None), checkSuite={"app": {"slug": "github-actions"}, "workflowRun": {"event": "pull_request"}})
        got = self.learn(answer(nodes=[merged("main", MERGE, ck("build"), ck("queue-only", event="merge_group"), expected, never)]))
        self.assertEqual(got, {"ran": ["build"], "merged": 1})

    def test_the_merged_count_is_the_heads_read_up_to_three(self):
        nodes = [merged("main", "2026-01-0%dT00:00:00Z" % d, ck("c%d" % d)) for d in (1, 2, 3, 4)] + [merged("release", "2026-01-09T00:00:00Z", ck("other"))]
        self.assertEqual(self.learn(answer(nodes=nodes)), {"ran": ["c4", "c3", "c2"], "merged": 3})

    def test_no_merged_pull_request_of_that_base_gives_no_learn(self):
        self.assertIsNone(self.learn(answer(nodes=[merged("release", MERGE, ck("a"))])))

    def test_an_error_anywhere_under_the_merged_path_gives_no_learn_even_a_run_error(self):
        path = ["r0", "merged", "nodes", 0, "commits", "nodes", 0, "commit", "statusCheckRollup", "contexts", "nodes", 0, "checkSuite", "workflowRun"]
        resp = answer(nodes=[merged("main", MERGE, ck("fine"))], errors=[{"type": "FORBIDDEN", "path": path, "message": "no access"}])
        self.assertEqual(self.batch(resp)["baseline"], {"names": ["fine"]})

    def test_a_merged_head_with_more_checks_than_were_read_gives_no_learn(self):
        resp = answer(nodes=[dict(merged("main", MERGE, ck("a")), commits={"nodes": [{"commit": {"statusCheckRollup": prt.rollup(ck("a"), total=150)}}]})])
        got = self.batch(resp)["baseline"]
        self.assertNotIn("learn", got)
        self.assertEqual(got["names"], ["a"])

    def test_a_merged_head_with_no_readable_commit_gives_no_learn(self):
        resp = answer(nodes=[{"baseRefName": "main", "mergedAt": MERGE, "commits": {"nodes": []}}])
        self.assertEqual(self.batch(resp)["baseline"], {"names": []})

    def test_reaching_the_cap_of_200_names_gives_no_learn(self):
        nodes = [merged("main", MERGE, *[ck("job-%03d" % i) for i in range(100)]), merged("main", "2026-01-01T23:30:00Z", *[ck("more-%03d" % i) for i in range(100)])]
        got = self.batch(answer(nodes=nodes))["baseline"]
        self.assertNotIn("learn", got)
        self.assertEqual(len(got["names"]), 100)
        few = [merged("main", MERGE, *[ck("job-%03d" % i) for i in range(100)]), merged("main", "2026-01-01T23:30:00Z", *[ck("more-%03d" % i) for i in range(99)])]
        self.assertEqual(len(self.learn(answer(nodes=few))["ran"]), 199)


if __name__ == "__main__":
    unittest.main()
