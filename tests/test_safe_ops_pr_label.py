"""The pr_label op of scripts/pr_ops.py (the ready label of a watched PR): read the labels first, `changed: false` without a write when the label is already in
the wanted state, `gh pr edit --add-label/--remove-label` otherwise, a missing label created once (no --force) and the add repeated; GitHub only, never model-facing."""
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_safe_ops_pr as pr_base  # noqa: E402
from test_safe_ops import safe_ops  # noqa: E402

ARGS = {"number": 7, "repo": "own/repo", "host": "ghe.example.com", "label": "ready", "on": True}
R = ["-R", "ghe.example.com/own/repo"]


def view(*names):
    return (0, json.dumps({"labels": [{"name": n, "color": "fff"} for n in names]}), "")


class LabelTest(pr_base.PrCase):
    def label(self, args, pr_host="auto", script=None):
        """Run the op with `script(argv)` answering each host call; returns (result, argv list)."""
        import pr_ops
        seen = []

        def fake(argv, root, subst=()):
            seen.append(list(argv))
            return script(argv) if script else (0, "", "")

        with mock.patch.object(pr_ops, "run_host", fake):
            res = safe_ops.handle({"op": "pr_label", "args": args, "cwd": self.repo, "config": {"prHost": pr_host}})
        return res, seen

    def test_op_is_allowlisted(self):
        self.assertIn("pr_label", safe_ops.PR_OPS)

    def test_add_reads_the_labels_then_edits(self):
        self.hosts("gh")
        res, seen = self.label(ARGS, script=lambda a: view("bug") if a[1:3] == ["pr", "view"] else (0, "", ""))
        res = self.ok(res)
        self.assertEqual((res["number"], res["label"], res["on"], res["changed"]), (7, "ready", True, True))
        self.assertEqual(seen[0][1:4], ["pr", "view", "7"])
        self.assertEqual(seen[0][4:], R + ["--json", "labels"])
        self.assertEqual(seen[1][1:], ["pr", "edit", "7"] + R + ["--add-label", "ready"])
        self.assertEqual(len(seen), 2)

    def test_remove_edits_with_remove_label(self):
        self.hosts("gh")
        res, seen = self.label({**ARGS, "on": False}, script=lambda a: view("ready") if a[1:3] == ["pr", "view"] else (0, "", ""))
        self.assertTrue(self.ok(res)["changed"])
        self.assertEqual(seen[1][1:], ["pr", "edit", "7"] + R + ["--remove-label", "ready"])

    def test_already_in_the_wanted_state_answers_changed_false_and_writes_nothing(self):
        self.hosts("gh")
        res, seen = self.label(ARGS, script=lambda a: view("ready"))
        self.assertFalse(self.ok(res)["changed"])
        self.assertEqual(len(seen), 1)
        res, seen = self.label({**ARGS, "on": False}, script=lambda a: view("bug"))
        self.assertFalse(self.ok(res)["changed"])
        self.assertEqual(len(seen), 1)

    def test_a_label_differing_only_in_case_counts_as_present(self):
        self.hosts("gh")
        res, seen = self.label(ARGS, script=lambda a: view("Ready"))
        self.assertFalse(self.ok(res)["changed"])
        self.assertEqual(len(seen), 1)
        res, seen = self.label({**ARGS, "on": False}, script=lambda a: view("READY") if a[1:3] == ["pr", "view"] else (0, "", ""))
        self.assertTrue(self.ok(res)["changed"])
        self.assertEqual(seen[1][-2:], ["--remove-label", "ready"])

    def test_a_missing_label_is_created_once_without_force_and_the_add_repeated(self):
        self.hosts("gh")
        state = {"edits": 0}

        def script(a):
            if a[1:3] == ["pr", "view"]:
                return view()
            if a[1:3] == ["pr", "edit"]:
                state["edits"] += 1
                return (1, "", "'ready' not found") if state["edits"] == 1 else (0, "", "")
            if a[1:3] == ["label", "list"]:
                return (0, json.dumps([{"name": "readyish"}]), "")
            return (0, "", "")

        res, seen = self.label(ARGS, script=script)
        self.assertTrue(self.ok(res)["changed"])
        self.assertEqual([a[1:3] for a in seen], [["pr", "view"], ["pr", "edit"], ["label", "list"], ["label", "create"], ["pr", "edit"]])
        self.assertEqual(seen[2][3:], R + ["--search", "ready", "--json", "name", "--limit", "100"])
        self.assertEqual(seen[3][1:], ["label", "create", "ready"] + R)
        self.assertNotIn("--force", seen[3])
        self.assertEqual(seen[4], seen[1])

    def test_an_add_that_fails_with_the_label_present_does_not_create(self):
        self.hosts("gh")

        def script(a):
            if a[1:3] == ["pr", "view"]:
                return view()
            if a[1:3] == ["pr", "edit"]:
                return (1, "", "HTTP 502")
            if a[1:3] == ["label", "list"]:
                return (0, json.dumps([{"name": "Ready"}]), "")
            return (0, "", "")

        res, seen = self.label(ARGS, script=script)
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], "pr_host_failed")
        self.assertNotIn(["label", "create"], [a[1:3] for a in seen])
        self.assertEqual(len([a for a in seen if a[1:3] == ["pr", "edit"]]), 1)

    def test_a_failing_remove_is_an_error_and_never_lists_or_creates(self):
        self.hosts("gh")
        res, seen = self.label({**ARGS, "on": False}, script=lambda a: view("ready") if a[1:3] == ["pr", "view"] else (1, "", "boom"))
        self.assertEqual(res["error"], "pr_host_failed")
        self.assertEqual([a[1:3] for a in seen], [["pr", "view"], ["pr", "edit"]])

    def test_a_failing_create_is_an_error_and_the_add_is_not_repeated(self):
        self.hosts("gh")

        def script(a):
            if a[1:3] == ["pr", "view"]:
                return view()
            if a[1:3] == ["label", "list"]:
                return (0, "[]", "")
            return (1, "", "denied")

        res, seen = self.label(ARGS, script=script)
        self.assertEqual(res["error"], "pr_host_failed")
        self.assertEqual([a[1:3] for a in seen], [["pr", "view"], ["pr", "edit"], ["label", "list"], ["label", "create"]])

    def test_glab_host_is_unsupported_and_nothing_runs(self):
        self.hosts("glab")
        res, seen = self.label(ARGS, "glab")
        self.refused(res, "pr_unsupported")
        self.assertEqual(seen, [])

    def test_template_host_is_unsupported_and_nothing_runs(self):
        self.hosts("gh")
        res, seen = self.label(ARGS, {"create": "mytool create"})
        self.refused(res, "pr_unsupported")
        self.assertEqual(seen, [])

    def test_bad_arguments_are_refused_before_the_host(self):
        self.hosts("gh")
        bad = [
            {k: v for k, v in ARGS.items() if k != "number"},
            {**ARGS, "number": 0},
            {k: v for k, v in ARGS.items() if k != "label"},
            {**ARGS, "label": ""},
            {**ARGS, "label": "x" * 51},
            {**ARGS, "label": "-ready"},
            {**ARGS, "label": "a,b"},
            {**ARGS, "label": "a\nb"},
            {**ARGS, "label": 7},
            {k: v for k, v in ARGS.items() if k != "on"},
            {**ARGS, "on": "yes"},
            {"number": 7, "label": "ready", "on": True, "host": "ghe.example.com"},
            {**ARGS, "extra": 1},
        ]
        for args in bad:
            res, seen = self.label(args)
            self.refused(res, "bad_request")
            self.assertEqual(seen, [], args)

    def test_a_label_of_50_characters_with_spaces_is_accepted(self):
        self.hosts("gh")
        name = "needs review " + "x" * 37
        res, seen = self.label({**ARGS, "label": name}, script=lambda a: view(name))
        self.assertFalse(self.ok(res)["changed"])


if __name__ == "__main__":
    unittest.main()
