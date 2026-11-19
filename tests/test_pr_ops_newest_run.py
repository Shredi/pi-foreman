"""pr_ops: a check counts by its newest run (a re-run supersedes the runs it replaces)."""
import unittest

import test_safe_ops_pr  # noqa: F401  (puts the scripts on the path)
import pr_ops

T1, T2, T3 = "2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z", "2026-01-01T02:00:00Z"


def ck(name, concl="SUCCESS", started=T1, done=None, wf=None, status="COMPLETED", app=None):
    nd = {"__typename": "CheckRun", "name": name, "status": status, "conclusion": concl, "startedAt": started,
          "completedAt": done, "databaseId": 1}
    if wf or app:
        nd["checkSuite"] = {"app": {"slug": app} if app else None, "workflowRun": {"event": "push", "workflow": {"name": wf}} if wf else None}
    return nd


def sc(name, state, created):
    return {"__typename": "StatusContext", "context": name, "state": state, "createdAt": created}


def roll(*nodes, total=None):
    return {"contexts": {"totalCount": len(nodes) if total is None else total, "nodes": list(nodes)}}


def counts(r):
    return pr_ops.map_rollup(r)["counts"]


class NewestRunTest(unittest.TestCase):
    def test_older_failure_newer_success_is_passed_only(self):
        r = roll(ck("p", "FAILURE", T1), ck("p", "SUCCESS", T2), ck("p", "SUCCESS", T3))
        self.assertEqual(counts(r), {"pending": 0, "failed": 0, "passed": 1, "missing": 0})
        self.assertEqual([x["bucket"] for x in pr_ops.watch_runs(r)], ["passed"])

    def test_older_success_newer_failure_is_failed(self):
        r = roll(ck("p", "SUCCESS", T1), ck("p", "FAILURE", T2))
        self.assertEqual(counts(r), {"pending": 0, "failed": 1, "passed": 0, "missing": 0})

    def test_order_in_the_list_does_not_matter(self):
        r = roll(ck("p", "SUCCESS", T3), ck("p", "FAILURE", T1))
        self.assertEqual(counts(r)["passed"], 1)
        self.assertEqual(counts(r)["failed"], 0)

    def test_newer_pending_and_unstarted_are_newest(self):
        r = roll(ck("p", "SUCCESS", T1), ck("p", None, T2, status="IN_PROGRESS"))
        self.assertEqual(counts(r)["pending"], 1)
        r = roll(ck("p", "SUCCESS", T1), ck("p", None, None, status="QUEUED"))
        self.assertEqual(counts(r)["pending"], 1)
        self.assertEqual(counts(r)["passed"], 0)

    def test_tie_goes_to_the_later_completion(self):
        r = roll(ck("p", "FAILURE", T1, done=T2), ck("p", "SUCCESS", T1, done=T3))
        self.assertEqual(counts(r)["passed"], 1)
        r = roll(ck("p", "SUCCESS", T1, done=T3), ck("p", "FAILURE", T1, done=T2))
        self.assertEqual(counts(r)["passed"], 1)

    def test_same_name_in_two_workflows_stays_two_checks(self):
        r = roll(ck("build", "FAILURE", T1, wf="A"), ck("build", "SUCCESS", T2, wf="B"))
        self.assertEqual(counts(r), {"pending": 0, "failed": 1, "passed": 1, "missing": 0})

    def test_same_workflow_without_name_keys_by_app_then_name(self):
        r = roll(ck("x", "FAILURE", T1, app="a1"), ck("x", "SUCCESS", T2, app="a2"), ck("x", "SUCCESS", T3, app="a2"))
        self.assertEqual(counts(r)["failed"], 1)
        self.assertEqual(counts(r)["passed"], 1)
        r = roll(ck("x", "FAILURE", T1), ck("x", "SUCCESS", T2))
        self.assertEqual(counts(r), {"pending": 0, "failed": 0, "passed": 1, "missing": 0})

    def test_status_context_by_created_at(self):
        r = roll(sc("ci", "FAILURE", T1), sc("ci", "SUCCESS", T2))
        self.assertEqual(counts(r), {"pending": 0, "failed": 0, "passed": 1, "missing": 0})
        r = roll(sc("ci", "SUCCESS", T1), sc("ci", "FAILURE", T2))
        self.assertEqual(counts(r)["failed"], 1)

    def test_dedup_is_not_truncation(self):
        r = roll(ck("p", "FAILURE", T1), ck("p", "SUCCESS", T2))
        runs = pr_ops.watch_runs(r, ["p"])
        self.assertFalse(pr_ops.map_rollup(r)["truncated"])
        self.assertFalse(pr_ops.run_list_cut(r, runs))
        self.assertEqual(pr_ops.readable_required(["p"], r, runs), ["p"])

    def test_real_truncation_still_shows(self):
        r = roll(ck("p", "FAILURE", T1), ck("p", "SUCCESS", T2), total=150)
        runs = pr_ops.watch_runs(r, ["q"])
        self.assertTrue(pr_ops.map_rollup(r)["truncated"])
        self.assertTrue(pr_ops.run_list_cut(r, runs))
        self.assertIsNone(pr_ops.readable_required(["q"], r, runs))

    def test_queries_ask_for_identity_and_order_fields(self):
        q = pr_ops._pr_query(1, watch=True, runs=True)
        self.assertIn("completedAt", q)
        self.assertIn("workflow { name }", q)
        self.assertIn("completedAt", pr_ops._pr_query(1, watch=True, runs=False))
        self.assertIn("workflow { name }", pr_ops._pr_query(1, watch=True, runs=True, merged=[0]).split("merged:")[1])


if __name__ == "__main__":
    unittest.main()
