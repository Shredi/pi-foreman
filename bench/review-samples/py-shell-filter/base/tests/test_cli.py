import io
import os
import tempfile
import unittest

from filelist.cli import main


class ListTest(unittest.TestCase):
    def test_list_prints_sorted_relative_paths(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, "sub"))
            for rel in ("b.md", "a.txt", os.path.join("sub", "c.txt")):
                open(os.path.join(root, rel), "w").close()
            out = io.StringIO()
            self.assertEqual(main(["list", root], out), 0)
            self.assertEqual(out.getvalue().split(), ["a.txt", "b.md", os.path.join("sub", "c.txt")])


if __name__ == "__main__":
    unittest.main()
