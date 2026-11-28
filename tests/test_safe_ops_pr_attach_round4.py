"""Round 4: partial uploads do not claim `attached`; the kept-locally check matches whole path tokens."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_safe_ops_pr_attach_partial as base


class Round4Test(base.PartialTest):
    def test_partial_pr_attach_reports_requested_not_attached(self):
        res, _ = self.run_op("pr_attach", {"number": 5, "attach": ["a.png", "b.png"]}, out=base.URL + "#issuecomment-1\n")
        self.assertNotIn("attached", res)
        self.assertEqual(res["attach_requested"], 2)
        self.assertIn("boom", res["attach_partial"])

    def test_partial_pr_create_reports_requested_not_attached(self):
        res, _ = self.run_op("pr_create", {"title": "T", "body": "b", "attach": ["a.png", "b.png"]})
        self.assertNotIn("attached", res)
        self.assertEqual(res["attach_requested"], 2)

    def test_full_pr_attach_still_reports_attached(self):
        res, _ = self.run_op("pr_attach", {"number": 5, "attach": ["a.png"]}, code=0)
        self.assertEqual(res["attached"], 1)

    def test_other_file_name_containing_the_path_is_not_named(self):
        res, bodies = self.run_op("pr_create", {"title": "T", "body": "see data.png\n", "attach": ["a.png"]}, code=0, version="gh version 2.1.0")
        self.assertTrue(res["ok"], res)
        self.assertIn("Screenshots (kept locally, not uploaded): `a.png`", bodies[0])

    def named(self, body):
        res, bodies = self.run_op("pr_create", {"title": "T", "body": body, "attach": ["a.png"]}, code=0, version="gh version 2.1.0")
        self.assertEqual(bodies[0], body, body)

    def test_named_in_image_reference(self):
        self.named("![x](a.png)\n")

    def test_named_in_dot_slash_reference(self):
        self.named("![x](./a.png)\n")

    def test_named_in_angle_reference(self):
        self.named("![x](<a.png>)\n")

    def test_named_in_backticks(self):
        self.named("file `a.png` here\n")

    def test_named_bare(self):
        self.named("a.png\n")


del base.PartialTest
if __name__ == "__main__":
    unittest.main()
