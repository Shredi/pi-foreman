import subprocess
import unittest


class TotalTest(unittest.TestCase):
    def test_total(self):
        out = subprocess.run(["python3", "/app/compute.py"], stdout=subprocess.PIPE, check=True).stdout.decode()
        self.assertEqual(out.strip(), "91")


if __name__ == "__main__":
    unittest.main()
