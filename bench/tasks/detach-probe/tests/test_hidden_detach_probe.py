import unittest
from pathlib import Path


class ResultTest(unittest.TestCase):
    def test_result_file(self):
        p = Path("/app/result.txt")
        self.assertTrue(p.is_file(), "result.txt missing")
        self.assertEqual(p.read_text().strip(), "91")


if __name__ == "__main__":
    unittest.main()
