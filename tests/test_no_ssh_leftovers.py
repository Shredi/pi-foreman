"""The ssh transport, the pull poll and the outbox are gone: no source or doc text names them any more."""
from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TREES = ("scripts", "extensions", "docs")
SKIP_DIRS = {"node_modules", "__pycache__", ".git", "test"}  # extension tests keep old keys as negative fixtures
SUFFIXES = {".py", ".ts", ".mjs", ".js", ".json", ".md", ".ps1", ".sh"}
FORBIDDEN = ("remote outbox", "returnPath", "ControlMaster")


def sources():
    for tree in TREES:
        for path in sorted((ROOT / tree).rglob("*")):
            parts = set(path.relative_to(ROOT).parts[:-1])
            if path.is_file() and path.suffix in SUFFIXES and not parts & SKIP_DIRS:
                yield path


class NoSshLeftoversTest(unittest.TestCase):
    def test_trees_are_scanned(self):
        names = {p.name for p in sources()}
        self.assertIn("foreman_session.py", names)
        self.assertIn("sessions.md", names)
        self.assertIn("index.ts", names)

    def test_no_forbidden_text(self):
        hits = []
        for path in sources():
            text = path.read_text("utf-8", "replace")
            for word in FORBIDDEN:
                if word in text:
                    hits.append("%s: %s" % (path.relative_to(ROOT).as_posix(), word))
        self.assertEqual(hits, [])


if __name__ == "__main__":
    unittest.main()
