"""merge_reviews_block of scripts/pr_ops.py: markers count only as whole lines; a stray closing marker never makes a second section."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_safe_ops import safe_ops  # noqa: F401  (puts scripts/ on sys.path)

OPEN = "<!-- pi-foreman:reviews -->"
CLOSE = "<!-- /pi-foreman:reviews -->"


def block(line):
    return "%s\n%s\n%s" % (OPEN, line, CLOSE)


class MergeLinesTest(unittest.TestCase):
    def merge(self, body, line="new"):
        import pr_ops
        return pr_ops.merge_reviews_block(body, block(line))

    def test_a_body_naming_the_markers_in_prose_is_not_rewritten(self):
        body = "Changelog: the line sits between %s and %s in the body.\n" % (OPEN, CLOSE)
        out = self.merge(body)
        self.assertTrue(out.startswith(body))
        self.assertEqual(out, body + "\n## Reviews\n\n" + block("new") + "\n")

    def test_whole_line_markers_are_replaced(self):
        body = "intro\n\n## Reviews\n\n%s\nold\n%s\n\ntail\n" % (OPEN, CLOSE)
        self.assertEqual(self.merge(body), "intro\n\n## Reviews\n\n%s\n\ntail\n" % block("new"))

    def test_a_stray_closing_marker_is_idempotent(self):
        body = "intro\n%s\nmore\n" % CLOSE
        once = self.merge(body, "one")
        twice = self.merge(once, "two")
        self.assertEqual(twice.count("## Reviews"), 1)
        self.assertEqual(twice, self.merge(body, "two"))
        self.assertIn(CLOSE + "\nmore", once)


if __name__ == "__main__":
    unittest.main()
