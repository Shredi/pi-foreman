import sys
import unittest

sys.path.insert(0, "/app")
from text_utils import shout, slugify  # noqa: E402


class HiddenSlugifyTest(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(slugify("Hello, World!"), "hello-world")

    def test_runs_and_ends(self):
        self.assertEqual(slugify("  --A  b__c 12 "), "a-b-c-12")

    def test_shout_unchanged(self):
        self.assertEqual(shout("hi"), "HI!")


if __name__ == "__main__":
    unittest.main()
