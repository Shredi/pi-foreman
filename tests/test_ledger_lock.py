"""core/scripts/ledger.py: two processes adding to one ledger lose nothing; the sidecar lock is taken over
when stale and gives a clear error when it stays held (D181)."""

import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "core" / "scripts"
LEDGER = SCRIPTS / "ledger.py"
sys.path.insert(0, str(SCRIPTS))
import ledger  # noqa: E402

BODY = "# Ledger\n\n- [ ] 1. first\n- [ ] V. verify\n"


def make(tmp):
    p = Path(tmp) / "LEDGER-lock.md"
    p.write_text(BODY, encoding="utf-8")
    return p


class LedgerLockTest(unittest.TestCase):
    def test_two_processes_lose_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make(tmp)
            code = (
                "import sys,subprocess\n"
                f"for i in range(60):\n"
                f"    r=subprocess.run([sys.executable,{str(LEDGER)!r},'-f',{str(p)!r},'add','w'+sys.argv[1]+'-'+str(i)],capture_output=True,text=True)\n"
                "    assert r.returncode==0, r.stderr\n"
            )
            procs = [subprocess.Popen([sys.executable, "-c", code, str(n)]) for n in "ab"]
            self.assertEqual([q.wait(timeout=240) for q in procs], [0, 0])
            text = p.read_text(encoding="utf-8")
            for n in "ab":
                for i in range(60):
                    self.assertIn(f" w{n}-{i}\n", text)
            self.assertEqual(text.count(" w"), 120)
            self.assertFalse(Path(str(p) + ".lock").exists())

    def test_stale_lock_is_taken_over(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make(tmp)
            lock = Path(str(p) + ".lock")
            lock.write_text(f"999999 {int((time.time() - 3600) * 1000)}\n", encoding="utf-8")
            r = subprocess.run([sys.executable, str(LEDGER), "-f", str(p), "add", "after"], capture_output=True, text=True, timeout=60)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn(" after\n", p.read_text(encoding="utf-8"))
            self.assertFalse(lock.exists())

    def test_held_lock_gives_error_and_no_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make(tmp)
            lock = Path(str(p) + ".lock")
            lock.write_text(f"{os.getpid()} {int(time.time() * 1000)}\n", encoding="utf-8")
            old = ledger.LOCK_WAIT_S
            ledger.LOCK_WAIT_S = 0.3
            try:
                with self.assertRaises(ledger.LedgerLocked) as cm:
                    ledger._take_lock(str(p))
            finally:
                ledger.LOCK_WAIT_S = old
            self.assertIn("locked by another writer", str(cm.exception))
            self.assertEqual(p.read_text(encoding="utf-8"), BODY)
            self.assertTrue(lock.exists(), "a live holder's lock is left alone")


if __name__ == "__main__":
    unittest.main()
