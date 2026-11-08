"""Bare `work` entry of the own handoff dir stays parent-protected; literal absolute ruling.md / result.md spellings."""
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import shell_write_guard as swg  # noqa: E402



class HandoffWorkEntry(unittest.TestCase):
    def setUp(self):
        base = os.path.realpath(tempfile.mkdtemp(prefix="pf-swg-hw-"))
        self.addCleanup(shutil.rmtree, base, True)
        self.ws = os.path.join(base, "ws").replace(os.sep, "/")
        # forward slashes: bash would eat the backslashes of a native Windows path
        self.h = os.path.join(base, "agent", "handoffs", "h1").replace(os.sep, "/")
        os.makedirs(self.ws)
        os.makedirs(os.path.join(self.h, "work"))
        self.owned = [os.path.join(base, "agent", "handoffs")]

    def d(self, cmd):
        return swg.decide(cmd, self.ws, self.ws, "bash", None, None, self.owned, self.h)

    def test_literal_absolute_names(self):
        self.assertIsNotNone(self.d(f"echo x > {self.h}/ruling.md"))
        self.assertIsNone(self.d(f"echo x > {self.h}/result.md"))

    def test_into_work_allowed(self):
        self.assertIsNone(self.d(f"echo x > {self.h}/work/a.txt"))
        self.assertIsNone(self.d(f"mkdir -p {self.h}/work/sub"))
        self.assertIsNone(self.d(f"rm -rf {self.h}/work/sub"))

    def test_work_entry_itself_refused(self):
        for cmd in (f"rm -rf {self.h}/work", f"mv {self.h}/work {self.ws}/x", f"rm -rf {self.h}/work/",
                    'rm -rf "$PI_FOREMAN_HANDOFF_DIR/work"'):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(self.d(cmd))


if __name__ == "__main__":
    unittest.main()
