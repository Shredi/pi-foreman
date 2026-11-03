"""config/secret-paths.json is read by foreman_sync; a missing or bad file falls back to the inline list."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_sync as fs  # noqa: E402

OLD_NAMES = [".env*", "*.pem", "*.key", "*.p12", "id_rsa*", "id_ed25519*", "*credential*", "*secret*", "*token*",
             ".npmrc", ".netrc", ".pypirc", ".git-credentials", "*.kdbx", "*.jks", "*.pfx", "id_ecdsa*"]


class SecretPathsTest(unittest.TestCase):
    def test_file_is_used(self):
        data = json.loads(Path(fs.SECRET_PATHS_FILE).read_text(encoding="utf-8"))
        self.assertEqual(fs.load_secret_globs(), data)
        for pat in data:
            self.assertIn(pat, fs.SECRET_NAMES)

    def test_superset_of_previous_names(self):
        self.assertTrue(set(OLD_NAMES) <= set(fs.SECRET_NAMES))

    def test_missing_or_bad_file_falls_back(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(fs.load_secret_globs(str(Path(d) / "absent.json")), fs.SECRET_GLOBS_INLINE)
            bad = Path(d) / "bad.json"
            bad.write_text("{not json", encoding="utf-8")
            self.assertEqual(fs.load_secret_globs(str(bad)), fs.SECRET_GLOBS_INLINE)
            wrong = Path(d) / "wrong.json"
            wrong.write_text('["ok", ""]', encoding="utf-8")
            self.assertEqual(fs.load_secret_globs(str(wrong)), fs.SECRET_GLOBS_INLINE)


if __name__ == "__main__":
    unittest.main()
