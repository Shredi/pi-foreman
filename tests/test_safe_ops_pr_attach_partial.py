"""Partial attach upload (gh exits non-zero but printed the URL) and a body that names an image as a markdown image reference."""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_safe_ops_pr as pr_base
from test_safe_ops import safe_ops

URL = "https://github.com/own/repo/pull/5"


class PartialTest(pr_base.PrCase):
    def run_op(self, op, args, code=1, out=URL + "\n", err="failed to upload b.png: boom\n", version="gh version 2.106.0 (x)"):
        import pr_ops
        bodies = []

        def fake(argv, root, subst=()):
            if argv[1:2] == ["--version"]:
                return (0, version + "\n", "")
            if "--body-file" in argv:
                bodies.append(Path(argv[argv.index("--body-file") + 1]).read_text(encoding="utf-8"))
            return (code, out, err)

        self.hosts("gh")
        self.ready()
        with mock.patch.object(pr_ops, "run_host", fake):
            return safe_ops.handle({"op": op, "args": args, "cwd": self.repo, "config": {"prHost": "gh"}}), bodies

    def test_create_with_failed_upload_is_reported_as_created(self):
        res, _ = self.run_op("pr_create", {"title": "T", "body": "b", "attach": ["a.png", "b.png"]})
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["number"], 5)
        self.assertEqual(res["url"], URL)
        self.assertIn("boom", res["attach_partial"])

    def test_create_failure_without_url_stays_a_failure(self):
        res, _ = self.run_op("pr_create", {"title": "T", "body": "b", "attach": ["a.png"]}, out="")
        self.assertFalse(res["ok"], res)

    def test_create_nonzero_without_attach_stays_a_failure(self):
        res, _ = self.run_op("pr_create", {"title": "T", "body": "b"})
        self.assertFalse(res["ok"], res)

    def test_pr_attach_with_comment_url_is_posted_with_attach_partial(self):
        res, _ = self.run_op("pr_attach", {"number": 5, "attach": ["a.png", "b.png"]}, out=URL + "#issuecomment-1\n")
        self.assertTrue(res["ok"], res)
        self.assertIn("issuecomment", res["url"])
        self.assertIn("boom", res["attach_partial"])

    def test_pr_attach_failure_without_url_stays_a_failure(self):
        res, _ = self.run_op("pr_attach", {"number": 5, "attach": ["a.png"]}, out="")
        self.assertFalse(res["ok"], res)

    def test_markdown_image_reference_counts_as_naming_the_path_when_degraded(self):
        body = "## Verification\n![shot](.workflow/screenshots/a.png)\n"
        res, bodies = self.run_op("pr_create", {"title": "T", "body": body, "attach": [".workflow/screenshots/a.png"]}, code=0, version="gh version 2.1.0")
        self.assertTrue(res["ok"], res)
        self.assertEqual(bodies[0], body)


if __name__ == "__main__":
    unittest.main()
