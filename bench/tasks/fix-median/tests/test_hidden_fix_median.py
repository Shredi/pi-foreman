import sys
import unittest

sys.path.insert(0, "/app")
from stats import median  # noqa: E402


class HiddenMedianTest(unittest.TestCase):
    def test_even(self):
        self.assertEqual(median([4, 1, 3, 2]), 2.5)

    def test_odd(self):
        self.assertEqual(median([5, 1, 3]), 3)

    def test_empty(self):
        with self.assertRaises(ValueError):
            median([])


if __name__ == "__main__":
    unittest.main()
