import hashlib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORE = ROOT / "core"
PINNED_SHA = "1b51ec10e0c5896e67ae867dd4bb542324400e50"
GENERATED = ("VERSION", "MANIFEST")
IGNORED_PARTS = ("__pycache__", ".pytest_cache")


def actual_files():
    out = {}
    for p in CORE.rglob("*"):
        rel = p.relative_to(CORE)
        if not p.is_file() or rel.as_posix() in GENERATED:
            continue
        if any(part in IGNORED_PARTS for part in rel.parts) or p.suffix == ".pyc":
            continue
        out[rel.as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


class CorePinTest(unittest.TestCase):
    def test_manifest_matches_core(self):
        want = {}
        for line in (CORE / "MANIFEST").read_text(encoding="utf-8").splitlines():
            digest, _, rel = line.partition("  ")
            want[rel] = digest
        have = actual_files()
        self.assertEqual(sorted(set(want) - set(have)), [], "missing files")
        self.assertEqual(sorted(set(have) - set(want)), [], "extra files")
        self.assertEqual(
            [r for r in want if want[r] != have[r]], [], "changed files"
        )

    def test_version_names_pinned_sha(self):
        text = (CORE / "VERSION").read_text(encoding="utf-8")
        self.assertIn("sha: " + PINNED_SHA, text.splitlines())


if __name__ == "__main__":
    unittest.main()
