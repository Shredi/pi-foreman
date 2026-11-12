"""pr_batch (watch): the merge state and the base branch's required checks, and the retry on a host that rejects those fields."""
import json
import unittest
from unittest import mock

import test_safe_ops_pr as prt
import pr_ops

RULE = {"branchProtectionRule": {"requiredStatusCheckContexts": ["ci-ok", "pr-policy"]}, "rules": {"nodes": []}}


def watch_pr(**kw):
    return prt.gql_pr(5, prt.rollup(dict(prt.run("pr-policy"), databaseId=1)), headRefOid="abc1234567", baseRefName="main",
                      updatedAt="2026-01-02T00:00:00Z", **kw)


class PolicyBatchTest(prt.RepoLessCase):
    def watch(self, pr):
        self.scn({"gh api graphql": {"stdout": prt.j({"data": {"r0": pr}})}})
        return self.ok(self.at("pr_batch", prs=[{"repo": "acme/lib", "n": 5}], watch=True))["prs"][0]

    def test_query_asks_for_merge_state_and_required_checks_only_in_watch_mode(self):
        self.watch(watch_pr(mergeStateStatus="CLEAN", baseRef=RULE))
        query = json.loads(self.calls()[0]["body"])["query"]
        for frag in ("mergeStateStatus", "baseRef", "branchProtectionRule", "requiredStatusCheckContexts", "RequiredStatusChecksParameters", "requiredStatusChecks"):
            self.assertIn(frag, query)
        self.scn({"gh api graphql": {"stdout": prt.j({"data": {"r0": prt.gql_pr(5, prt.rollup())}})}})
        self.ok(self.at("pr_batch", prs=[{"repo": "acme/lib", "n": 5}]))
        self.assertNotIn("mergeStateStatus", json.loads(self.calls()[1]["body"])["query"])

    def test_required_from_classic_protection_and_rulesets_and_the_merge_state(self):
        base = {"branchProtectionRule": {"requiredStatusCheckContexts": ["ci-ok", "pr-policy"]},
                "rules": {"nodes": [{"parameters": {"requiredStatusChecks": [{"context": "pr-policy"}, {"context": "lint"}]}}, {"parameters": {}}]}}
        got = self.watch(watch_pr(mergeStateStatus="BLOCKED", baseRef=base))
        self.assertEqual(got["required"], ["ci-ok", "pr-policy", "lint"])
        self.assertEqual(got["mergeState"], "blocked")

    def test_no_required_checks_is_an_empty_list_not_unreadable(self):
        got = self.watch(watch_pr(mergeStateStatus="CLEAN", baseRef={"branchProtectionRule": None, "rules": {"nodes": []}}))
        self.assertEqual(got["required"], [])

    def test_unreadable_required_is_null(self):
        self.assertIsNone(self.watch(watch_pr())["required"])
        self.assertIsNone(self.watch(watch_pr(baseRef=None))["required"])
        self.scn({"gh api graphql": {"stdout": prt.j({"data": {"r0": watch_pr(baseRef=RULE)},
                                                         "errors": [{"type": "FORBIDDEN", "path": ["r0", "pullRequest", "baseRef", "rules"], "message": "no"}]})}})
        got = self.ok(self.at("pr_batch", prs=[{"repo": "acme/lib", "n": 5}], watch=True))["prs"][0]
        self.assertIsNone(got["required"])
        self.assertIsNone(self.watch(watch_pr(mergeStateStatus="WEIRD"))["mergeState"])

    def _cut_pr(self, names, required, total=None, count=150):
        runs = [dict(prt.run("matrix-job-%03d-%s" % (i, "x" * 90)), databaseId=i) for i in range(count)]
        runs += [dict(prt.run(n), databaseId=1000 + i) for i, n in enumerate(names)]
        base = {"branchProtectionRule": {"requiredStatusCheckContexts": required}, "rules": {"nodes": []}}
        return prt.gql_pr(5, prt.rollup(*runs, total=total), headRefOid="abc1234567", baseRefName="main",
                          updatedAt="2026-01-02T00:00:00Z", baseRef=base)

    def test_required_run_survives_the_size_cut_when_it_is_last(self):
        got = self.watch(self._cut_pr(["ci-ok"], ["ci-ok"]))
        self.assertLess(len(got["runs"]), 150)
        self.assertIn("ci-ok", [r["name"] for r in got["runs"]])
        self.assertEqual(got["required"], ["ci-ok"])

    def test_required_is_null_when_required_runs_are_cut(self):
        names = ["req-%02d-%s" % (i, "y" * 180) for i in range(50)]
        got = self.watch(self._cut_pr(names, names, count=0))
        self.assertLess(len(got["runs"]), 50)
        self.assertIsNone(got["required"])

    def test_required_is_null_when_the_rollup_is_truncated_and_the_required_check_is_not_among_the_nodes(self):
        got = self.watch(self._cut_pr(["other"], ["ci-ok"], total=130, count=3))
        self.assertIsNone(got["required"])

    def test_required_stays_a_list_when_the_rollup_is_truncated_but_every_required_name_is_present(self):
        got = self.watch(self._cut_pr(["ci-ok"], ["ci-ok"], total=130, count=3))
        self.assertEqual(got["required"], ["ci-ok"])

    def test_required_stays_a_list_when_absent_from_a_complete_uncut_list(self):
        got = self.watch(self._cut_pr(["other"], ["ci-ok"], count=3))
        self.assertEqual(got["required"], ["ci-ok"])

    def test_a_host_that_rejects_the_new_fields_is_asked_again_without_them(self):
        bad = {"errors": [{"type": "undefinedField", "message": "Field 'mergeStateStatus' doesn't exist on type 'PullRequest'"}]}
        good = {"data": {"r0": watch_pr()}}
        queries = []

        def fake(argv, root, subst=()):
            with open(argv[argv.index("--input") + 1], encoding="utf-8") as f:
                q = json.load(f)["query"]
            queries.append(q)
            return (1, prt.j(bad), "") if "mergeStateStatus" in q else (0, prt.j(good), "")

        with mock.patch.object(pr_ops, "run_host", fake):
            got = self.ok(self.at("pr_batch", prs=[{"repo": "acme/lib", "n": 5}], watch=True))["prs"][0]
        self.assertEqual(len(queries), 2)
        self.assertIn("mergeStateStatus", queries[0])
        self.assertNotIn("mergeStateStatus", queries[1])
        self.assertNotIn("requiredStatusCheckContexts", queries[1])
        self.assertIsNone(got["required"])
        self.assertIsNone(got["mergeState"])
        self.assertEqual(got["headSha"], "abc1234567")
        self.assertEqual([r["name"] for r in got["runs"]], ["pr-policy"])

    def test_rate_limit_is_not_retried(self):
        self.scn({"gh api graphql": {"stdout": prt.j({"errors": [{"type": "RATE_LIMITED", "message": "x"}]}), "exit": 1}})
        self.assertEqual(self.at("pr_batch", prs=[{"repo": "acme/lib", "n": 5}], watch=True)["error"], "pr_host_failed")
        self.assertEqual(len(self.calls()), 1)

    def test_other_error_is_not_retried_and_is_reported(self):
        queries = []

        def fake(argv, root, subst=()):
            queries.append(argv)
            return 1, "", "gh: HTTP 401: Bad credentials"

        with mock.patch.object(pr_ops, "run_host", fake):
            got = self.at("pr_batch", prs=[{"repo": "acme/lib", "n": 5}], watch=True)
        self.assertEqual(len(queries), 1)
        self.assertIn("error", got)
        self.assertIn("401", json.dumps(got))

    def test_unrelated_graphql_error_is_not_retried(self):
        bad = {"errors": [{"type": "FORBIDDEN", "message": "Resource not accessible"}]}
        self.scn({"gh api graphql": {"stdout": prt.j(bad), "exit": 1}})
        self.assertEqual(self.at("pr_batch", prs=[{"repo": "acme/lib", "n": 5}], watch=True)["error"], "pr_host_failed")
        self.assertEqual(len(self.calls()), 1)


if __name__ == "__main__":
    unittest.main()
