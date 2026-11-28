"""`foreman prs|dialogs|perms|features|knowledge` load without a resolvable @earendil-works/pi-coding-agent.

The CLIs run outside Pi, from a checkout whose node_modules may not hold the Pi package (it is a peer
dependency). A value import that reaches it fails with ERR_MODULE_NOT_FOUND before the usage text.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_SCOPE = "@earendil-works"


def node_ok():
    node = shutil.which("node")
    if not node:
        return False
    out = subprocess.run([node, "-e", "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=6)?0:1)"], capture_output=True)
    return out.returncode == 0


def link_or_copy(src, dst):
    if sys.platform == "win32":
        if src.is_dir():
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
    else:
        os.symlink(src, dst)


@unittest.skipUnless(shutil.which("sh") and node_ok(), "needs Node >= 22.6 and sh")
class NoPiPackage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.tmp.cleanup)
        cls.root = Path(cls.tmp.name).resolve() / "pf"  # resolved: the CLIs compare import.meta.url with argv[1]
        cls.root.mkdir()
        ignore = shutil.ignore_patterns("test", "__pycache__", "*.pyc")
        for name in ("bin", "scripts", "config", "extensions/core-adapter"):
            shutil.copytree(ROOT / name, cls.root / name, ignore=ignore)
        shutil.copy2(ROOT / "package.json", cls.root / "package.json")
        nm = cls.root / "node_modules"
        nm.mkdir()
        for entry in (ROOT / "node_modules").iterdir():
            if entry.name == SKIP_SCOPE:
                continue
            link_or_copy(entry, nm / entry.name)
        assert not (nm / SKIP_SCOPE).exists()

    def run_help(self, sub):
        env = {k: v for k, v in os.environ.items() if not k.startswith("NODE_")}
        return subprocess.run(["sh", str(self.root / "bin" / "foreman"), sub, "--help"], capture_output=True, text=True, env=env, timeout=60)

    def check(self, sub, code, marker="usage"):
        r = self.run_help(sub)
        err = r.stdout + r.stderr
        self.assertNotIn("ERR_MODULE_NOT_FOUND", err, err)
        self.assertNotIn("pi-coding-agent", err, err)
        self.assertEqual(r.returncode, code, err)
        self.assertIn(marker.lower(), err.lower(), err)

    def test_prs(self):
        self.check("prs", 2)

    def test_dialogs(self):
        self.check("dialogs", 0, "state_usage_read")

    def test_features(self):
        self.check("features", 2)

    def test_knowledge(self):
        self.check("knowledge", 2)

    def test_doctor(self):
        self.check("doctor", 0)


if __name__ == "__main__":
    unittest.main()
