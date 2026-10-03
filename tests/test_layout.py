import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class LayoutTest(unittest.TestCase):
    def test_layout(self):
        for name in ("LICENSE", "NOTICE", "AGENTS.md"):
            self.assertTrue((ROOT / name).is_file(), name)
        self.assertFalse((ROOT / "CLAUDE.md").exists())


if __name__ == "__main__":
    unittest.main()
