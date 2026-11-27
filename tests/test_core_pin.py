import hashlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORE = ROOT / "core"


GENERATED = ("MANIFEST",)
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


class ManifestRoundTripTest(unittest.TestCase):
    def test_write_manifest_roundtrip_and_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "scripts").mkdir()
            shutil.copy(ROOT / "scripts" / "pull_core.py", root / "scripts" / "pull_core.py")
            shutil.copytree(CORE, root / "core", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            script = str(root / "scripts" / "pull_core.py")

            def run(flag):
                return subprocess.run(
                    [sys.executable, "-I", script, flag], capture_output=True, text=True
                ).returncode

            original = (CORE / "MANIFEST").read_bytes()
            self.assertEqual(run("--write-manifest"), 0)
            self.assertEqual((root / "core" / "MANIFEST").read_bytes(), original)
            self.assertEqual(run("--check"), 0)
            target = next(p for p in sorted((root / "core").rglob("*.py")))
            target.write_bytes(target.read_bytes() + b"\n# edited\n")
            self.assertEqual(run("--check"), 1)
            self.assertEqual(run("--write-manifest"), 0)
            self.assertEqual(run("--check"), 0)


if __name__ == "__main__":
    unittest.main()
