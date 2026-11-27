"""The provider and cloud key-file globs of brief 1 are in config/secret-paths.json, in foreman_sync's SECRET_NAMES and in its inline fallback."""
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_sync as fs  # noqa: E402

NEW = ["rclone.conf", ".boto", ".s3cfg", "cookies.sqlite"]


class SecretKeyGlobsTest(unittest.TestCase):
    def test_new_globs_everywhere(self):
        for pat in NEW:
            self.assertIn(pat, fs.load_secret_globs())
            self.assertIn(pat, fs.SECRET_GLOBS_INLINE)
            self.assertIn(pat, fs.SECRET_NAMES)


if __name__ == "__main__":
    unittest.main()
