"""Ledger.save retries os.replace on PermissionError only (Windows reader/scanner races)."""
import errno
import glob
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "core", "scripts"))
import ledger  # noqa: E402

REAL_REPLACE = os.replace


class LedgerSaveRetryTest(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.path = os.path.join(self._td.name, "LEDGER-x.md")
        with open(self.path, "w", encoding="utf-8", newline="") as f:
            f.write("- [ ] 1. thing\n")
        self.led = ledger.Ledger(self.path)
        self.led.lines = ["- [x] 1. thing\n"]

    def _read(self):
        with open(self.path, encoding="utf-8", newline="") as f:
            return f.read()

    def test_transient_permission_error_is_retried(self):
        calls = []

        def flaky(src, dst):
            calls.append(1)
            if len(calls) <= 2:
                raise PermissionError(13, "Access is denied")
            REAL_REPLACE(src, dst)

        with mock.patch.object(ledger.os, "replace", flaky), \
                mock.patch.object(ledger.time, "sleep"):
            self.led.save()
        self.assertEqual(len(calls), 3)
        self.assertEqual(self._read(), "- [x] 1. thing\n")

    def test_persistent_permission_error_reraises_and_cleans_up(self):
        sleeps = []
        with mock.patch.object(ledger.os, "replace", side_effect=PermissionError(13, "denied")), \
                mock.patch.object(ledger.time, "sleep", side_effect=sleeps.append):
            with self.assertRaises(PermissionError):
                self.led.save()
        self.assertEqual(self._read(), "- [ ] 1. thing\n")
        self.assertEqual(glob.glob(os.path.join(self._td.name, ".ledger-*.tmp")), [])
        self.assertLessEqual(sum(sleeps), 2.0)

    def test_other_oserror_not_retried(self):
        with mock.patch.object(ledger.os, "replace", side_effect=OSError(errno.EXDEV, "xdev")) as rep, \
                mock.patch.object(ledger.time, "sleep") as slp:
            with self.assertRaises(OSError):
                self.led.save()
        self.assertEqual(rep.call_count, 1)
        slp.assert_not_called()
        self.assertEqual(glob.glob(os.path.join(self._td.name, ".ledger-*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
