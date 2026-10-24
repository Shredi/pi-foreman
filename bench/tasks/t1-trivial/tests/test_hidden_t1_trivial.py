"""Hidden check for the T1 trivial task: the one-line fix in mathx.py, and nothing else changed.

1. is_even(n) is True exactly for the even n, negatives and zero included.
2. The visible test (test_mathx.py) still passes.
3. The diff touches only mathx.py (.workflow/ and __pycache__ ignored).
"""
import subprocess
import sys
import unittest
from pathlib import Path

APP = Path("/app")


class T1TrivialTest(unittest.TestCase):
    def test_is_even_correct(self):
        sys.path.insert(0, str(APP))
        from mathx import is_even  # noqa: E402
        for n in range(-10, 11):
            self.assertEqual(is_even(n), n % 2 == 0, "is_even(%d)" % n)

    def test_visible_tests_pass(self):
        r = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", str(APP), "-p", "test_*.py"],
                           cwd=str(APP), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout.decode("utf-8", "replace")[-800:])

    def test_diff_only_mathx(self):
        out = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=str(APP),
                             stdout=subprocess.PIPE, check=True, timeout=60).stdout.decode("utf-8")
        paths = set()
        for line in out.splitlines():
            p = line[3:].split(" -> ")[-1].strip('"')
            if p.startswith(".workflow/") or "__pycache__" in p.split("/"):
                continue
            paths.add(p)
        self.assertEqual(paths, {"mathx.py"})


if __name__ == "__main__":
    unittest.main()
