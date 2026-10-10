import os
import tempfile
import unittest

from reports.store import ReportStore


class NamesTest(unittest.TestCase):
    def test_names_are_sorted_with_forward_slashes(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, "2026"))
            for rel in ("b.txt", os.path.join("2026", "q1.txt")):
                with open(os.path.join(root, rel), "w") as fh:
                    fh.write("x")
            self.assertEqual(ReportStore(root).names(), ["2026/q1.txt", "b.txt"])


if __name__ == "__main__":
    unittest.main()
