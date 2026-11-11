"""The sweep's protected_pattern against the table shared with the gate's TypeScript matcher (tests/fixtures/protected-branch-cases.json)."""
from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "scripts"))
import _isolation  # noqa: E402,F401
import foreman_worktree as fw  # noqa: E402

CASES = json.loads((HERE / "fixtures" / "protected-branch-cases.json").read_text(encoding="utf-8"))


class ProtectedPatternTableTest(unittest.TestCase):
    def test_rows(self):
        for row in CASES:
            with self.subTest(patterns=row["patterns"], branch=row["branch"]):
                cfg = {"safety": {"git": {"protectedBranches": row["patterns"]}}}
                got = fw.protected_pattern(cfg, row["branch"])
                self.assertEqual(got is not None, row["expected"], got)
                if got is not None:
                    self.assertIn(got, row["patterns"])


if __name__ == "__main__":
    unittest.main()
