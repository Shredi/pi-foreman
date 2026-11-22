"""The pr_body op of scripts/pr_ops.py (the reviews block of a PR the session opened): read the body, replace the block between the markers or append the
`## Reviews` section when they are missing, write it back with `gh pr edit --body-file`; an unchanged body is not written; GitHub only, never model-facing."""
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_safe_ops_pr as pr_base
from test_safe_ops import safe_ops

OPEN = "<!-- pi-foreman:reviews -->"
CLOSE = "<!-- /pi-foreman:reviews -->"
BLOCK = OPEN + "\nPre-pr review: PASS on abc1234 (run r1; suites: npm test (pass))\n" + CLOSE
ARGS = {"number": 7, "repo": "own/repo", "host": "ghe.example.com", "block": BLOCK}
R = ["-R", "ghe.example.com/own/repo"]


class BodyTest(pr_base.PrCase):
    def body(self, args, old="", pr_host="auto", edit_code=0):
        """Run the op with the PR body `old`; returns (result, argv list, the body file's text at the edit call)."""
        import pr_ops
        seen = []
        written = []

        def fake(argv, root, subst=()):
            seen.append(list(argv))
            if argv[1:3] == ["pr", "view"]:
                return (0, json.dumps({"body": old}), "")
            if argv[1:3] == ["pr", "edit"]:
                written.append(Path(argv[argv.index("--body-file") + 1]).read_text(encoding="utf-8"))
                return (edit_code, "", "" if edit_code == 0 else "boom")
            return (0, "", "")

        with mock.patch.object(pr_ops, "run_host", fake):
            res = safe_ops.handle({"op": "pr_body", "args": args, "cwd": self.repo, "config": {"prHost": pr_host}})
        return res, seen, written

    def test_op_is_allowlisted(self):
        self.assertIn("pr_body", safe_ops.PR_OPS)

    def test_markers_missing_appends_the_section_and_edits_with_a_body_file(self):
        self.hosts("gh")
        old = "## Summary\n\nDid it.\n\nHigh-stakes review: PASS on 1234567\n\n## Changelog\n\n- A change.\n"
        res, seen, written = self.body(ARGS, old)
        self.assertTrue(self.ok(res)["changed"])
        self.assertEqual(seen[0][1:4], ["pr", "view", "7"])
        self.assertEqual(seen[0][4:], R + ["--json", "body"])
        self.assertEqual(seen[1][1:4], ["pr", "edit", "7"])
        self.assertEqual(seen[1][4:6], R)
        self.assertEqual(seen[1][6], "--body-file")
        self.assertEqual(written, [old + "\n## Reviews\n\n" + BLOCK + "\n"])
        self.assertEqual(len(seen), 2)

    def test_markers_present_replaces_only_the_block(self):
        self.hosts("gh")
        stale = OPEN + "\nPre-pr review: PASS on 0000000\n" + CLOSE
        old = "Intro line\n\n## Reviews\n\nHigh-stakes review: PASS on 1234567\n" + stale + "\n\n## Changelog\n\n- A change.\n"
        res, seen, written = self.body(ARGS, old)
        self.assertTrue(self.ok(res)["changed"])
        self.assertEqual(written, [old.replace(stale, BLOCK)])
        self.assertIn("High-stakes review: PASS on 1234567", written[0])
        self.assertEqual(written[0].count(OPEN), 1)

    def test_an_empty_block_is_filled(self):
        self.hosts("gh")
        old = "## Reviews\n\n" + OPEN + CLOSE + "\n"
        res, seen, written = self.body(ARGS, old)
        self.assertTrue(self.ok(res)["changed"])
        self.assertEqual(written, ["## Reviews\n\n" + BLOCK + "\n"])

    def test_an_unchanged_body_is_not_written(self):
        self.hosts("gh")
        old = "x\n\n## Reviews\n\n" + BLOCK + "\n"
        res, seen, written = self.body(ARGS, old)
        self.assertFalse(self.ok(res)["changed"])
        self.assertEqual(len(seen), 1)
        self.assertEqual(written, [])

    def test_an_empty_body_gets_the_section_without_a_leading_blank_line(self):
        self.hosts("gh")
        res, seen, written = self.body(ARGS, "")
        self.assertEqual(written, ["## Reviews\n\n" + BLOCK + "\n"])

    def test_a_body_past_the_cap_after_the_merge_is_refused_and_not_written(self):
        self.hosts("gh")
        res, seen, written = self.body(ARGS, "x" * 65530)
        self.refused(res, "bad_request")
        self.assertEqual(written, [])
        self.assertEqual(len(seen), 1)

    def test_a_failing_edit_is_an_error(self):
        self.hosts("gh")
        res, seen, written = self.body(ARGS, "x", edit_code=1)
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], "pr_host_failed")

    def test_glab_and_template_hosts_are_unsupported_and_nothing_runs(self):
        self.hosts("glab")
        res, seen, written = self.body(ARGS, "x", "glab")
        self.refused(res, "pr_unsupported")
        self.assertEqual(seen, [])
        self.hosts("gh")
        res, seen, written = self.body(ARGS, "x", {"create": "mytool create"})
        self.refused(res, "pr_unsupported")
        self.assertEqual(seen, [])

    def test_bad_arguments_are_refused_before_the_host(self):
        self.hosts("gh")
        bad = [
            {k: v for k, v in ARGS.items() if k != "number"},
            {**ARGS, "number": 0},
            {k: v for k, v in ARGS.items() if k != "block"},
            {**ARGS, "block": ""},
            {**ARGS, "block": "plain text"},
            {**ARGS, "block": OPEN + "x"},
            {**ARGS, "block": BLOCK + BLOCK},
            {**ARGS, "block": OPEN + "a" * 4000 + CLOSE},
            {**ARGS, "block": 7},
            {"number": 7, "block": BLOCK, "host": "ghe.example.com"},
            {**ARGS, "extra": 1},
        ]
        for args in bad:
            res, seen, written = self.body(args)
            self.refused(res, "bad_request")
            self.assertEqual(seen, [], args)


if __name__ == "__main__":
    unittest.main()
