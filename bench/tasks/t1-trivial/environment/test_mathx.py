import unittest
from mathx import is_even


class MathxTest(unittest.TestCase):
    def test_is_even(self):
        self.assertTrue(is_even(4))
        self.assertFalse(is_even(3))


if __name__ == "__main__":
    unittest.main()
