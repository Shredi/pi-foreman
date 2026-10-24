"""Driver: PiRpc.close() never raises TimeoutExpired (Windows: Pi can exit slowly after stdin EOF).

The child is a plain Python process, so no Pi CLI is needed.
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import PiRpc  # noqa: E402

EXITS_ON_EOF = "import sys; sys.stdin.read()"
IGNORES_EOF = "import time; time.sleep(120)"


def rpc(code):
    return PiRpc([sys.executable, "-c", code], cwd=Path.cwd(), env=dict(os.environ))


class TestClose(unittest.TestCase):
    def test_timely_exit_returns_zero(self):
        p = rpc(EXITS_ON_EOF)
        p.close(timeout=20)
        self.assertEqual(p.proc.returncode, 0)

    def test_slow_exit_is_stopped_without_raising(self):
        p = rpc(IGNORES_EOF)
        p.close(timeout=0.5)
        self.assertIsNotNone(p.proc.returncode)


if __name__ == "__main__":
    unittest.main()
