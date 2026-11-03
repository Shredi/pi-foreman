"""shell_write_guard.py: the null device is no project write (A5). /dev/null on every platform; NUL (any case) only on
Windows, where it is the null device (on POSIX `> NUL` creates a file). Simulated on every host by patching `_NT`;
decisions over command STRINGS only, nothing is run."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import shell_write_guard as swg  # noqa: E402


class NullDeviceTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.ws = str(Path(self._tmp.name).resolve())

    def hit(self, line):
        return swg.decide(line, self.ws, self.ws)

    def test_dev_null_on_every_platform(self):
        for nt in (False, True):
            with mock.patch.object(swg, "_NT", nt):
                for line in ("ls >/dev/null", "ls 2>/dev/null", "ls &>/dev/null", "ls > /dev/null 2>&1"):
                    with self.subTest(nt=nt, line=line):
                        self.assertIsNone(self.hit(line))

    def test_nul_is_null_device_on_nt_only(self):
        for line in ("ls >NUL", "ls 2>nul", "ls > NUL", "ls &>Nul"):
            with self.subTest(line=line):
                with mock.patch.object(swg, "_NT", True):
                    self.assertIsNone(self.hit(line))
                with mock.patch.object(swg, "_NT", False):
                    self.assertEqual(self.hit(line)[0], "redirect")


if __name__ == "__main__":
    unittest.main()
