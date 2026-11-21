"""foreman_update_check._pid_alive: real answers everywhere, and no os.kill on Windows (signal 0 is CTRL_C_EVENT there)."""
from __future__ import annotations

import subprocess
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_update_check as uc  # noqa: E402


class PidAliveTest(unittest.TestCase):
    def test_current_process_alive_and_exited_child_dead(self):
        self.assertTrue(uc._pid_alive(__import__("os").getpid()))
        child = subprocess.Popen([sys.executable, "-c", "pass"])
        child.wait()
        self.assertFalse(uc._pid_alive(child.pid))

    def test_nonpositive_pid_is_dead(self):
        self.assertFalse(uc._pid_alive(0))
        self.assertFalse(uc._pid_alive(-1))

    def test_windows_branch_never_signals(self):
        k32 = mock.Mock()
        k32.OpenProcess.return_value = 7
        k32.WaitForSingleObject.return_value = 258
        fake_ctypes = types.SimpleNamespace(windll=types.SimpleNamespace(kernel32=k32))
        with mock.patch.object(uc.os, "name", "nt"), mock.patch.dict(sys.modules, {"ctypes": fake_ctypes}), \
                mock.patch.object(uc.os, "kill", side_effect=AssertionError("os.kill called")) as kill:
            self.assertTrue(uc._pid_alive(1234))
            k32.WaitForSingleObject.return_value = 0
            self.assertFalse(uc._pid_alive(1234))
            k32.OpenProcess.return_value = 0
            k32.GetLastError.return_value = 87
            self.assertFalse(uc._pid_alive(1234))
            k32.GetLastError.return_value = 5
            self.assertTrue(uc._pid_alive(1234))
        kill.assert_not_called()
        self.assertEqual(k32.CloseHandle.call_count, 2)


if __name__ == "__main__":
    unittest.main()
