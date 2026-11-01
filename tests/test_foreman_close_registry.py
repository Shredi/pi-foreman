"""scripts/foreman_close.py in_use_by: the session registry branch (an entry opened by `foreman session open`)."""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_close as fcl  # noqa: E402


class InUseByRegistryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="close_reg_")).resolve()
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.state = self.tmp / "state"
        self.state.mkdir()
        self.wt = self.tmp / "repo.worktrees" / "demo"
        (self.wt / "sub").mkdir(parents=True)

    def registry(self, status):
        entry = {"label": "demo", "child": "child-1", "status": status, "cwd": str(self.wt / "sub")}
        (self.state / "sessions.json").write_text(json.dumps({"sessions": [entry]}), "utf-8")

    def test_open_entry_inside_the_worktree_blocks_removal(self):
        self.registry("open")
        self.assertEqual(fcl.in_use_by(str(self.state), "caller", str(self.wt)), "child-1")

    def test_closed_entry_does_not_block_removal(self):
        self.registry("closed")
        self.assertIsNone(fcl.in_use_by(str(self.state), "caller", str(self.wt)))


if __name__ == "__main__":
    unittest.main()
