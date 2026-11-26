"""bin/ledger: two processes adding to one ledger through the shim lose nothing; the sidecar lock is taken over
when stale and gives a clear error, with ledger.py not run, when it stays held (D181). core/scripts/ledger.py holds
no lock itself (core/ is pinned): the shim's Node helper (bin/ledger-run.mjs) does."""

import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHIM = ROOT / "bin" / "ledger"
LEDGER = ROOT / "core" / "scripts" / "ledger.py"

BODY = "# Ledger\n\n- [ ] 1. first\n- [ ] V. verify\n"


def make(tmp):
    p = Path(tmp) / "LEDGER-lock.md"
    p.write_text(BODY, encoding="utf-8")
    return p


def shim_env(tmp):
    state = Path(tmp) / "state"
    state.mkdir(exist_ok=True)
    return dict(os.environ, PI_FOREMAN_PYTHON=sys.executable, PI_FOREMAN_STATE_DIR=str(state))


@unittest.skipUnless(shutil.which("sh") and shutil.which("node"), "sh and node are needed")
class LedgerLockTest(unittest.TestCase):
    def test_two_processes_lose_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make(tmp)
            code = (
                "import sys,subprocess\n"
                "for i in range(60):\n"
                f"    r=subprocess.run(['sh',{str(SHIM)!r},'-f',{str(p)!r},'add','w'+sys.argv[1]+'-'+str(i)],capture_output=True,text=True)\n"
                "    assert r.returncode==0, r.stderr\n"
            )
            env = shim_env(tmp)
            procs = [subprocess.Popen([sys.executable, "-c", code, str(n)], env=env) for n in "ab"]
            self.assertEqual([q.wait(timeout=480) for q in procs], [0, 0])
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
            r = subprocess.run(["sh", str(SHIM), "-f", str(p), "add", "after"], env=shim_env(tmp), capture_output=True, text=True, timeout=60)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn(" after\n", p.read_text(encoding="utf-8"))
            self.assertFalse(lock.exists())

    def test_held_lock_gives_error_and_ledger_py_does_not_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make(tmp)
            lock = Path(str(p) + ".lock")
            held = f"{os.getpid()} {int(time.time() * 1000)}\n"
            lock.write_text(held, encoding="utf-8")
            # a live holder keeps its stamp fresh (a lock older than the stale limit is a crashed holder's)
            beat = subprocess.Popen([sys.executable, "-c", (
                "import sys,time,os\n"
                "while True:\n"
                f"    open({str(lock)!r},'w').write('%d %d\\n' % (os.getppid(), time.time()*1000))\n"
                "    time.sleep(1)\n")])
            try:
                r = subprocess.run(["sh", str(SHIM), "-f", str(p), "add", "never"], env=shim_env(tmp), capture_output=True, text=True, timeout=120)
            finally:
                beat.kill()
                beat.wait()
            self.assertEqual(r.returncode, 1)
            self.assertIn("locked by another writer", r.stderr)
            self.assertEqual(p.read_text(encoding="utf-8"), BODY)
            self.assertTrue(lock.exists(), "a live holder's lock is left alone")

    def test_status_with_no_ledger_bound_is_ledger_pys_own_answer(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = shim_env(tmp)
            env.pop("LEDGER", None)
            env["PI_SESSION_ID"] = "no-such-session"
            via = subprocess.run(["sh", str(SHIM), "status"], env=env, cwd=tmp, capture_output=True, text=True, timeout=60)
            direct_env = dict(env, CLAUDE_CODE_SESSION_ID="no-such-session", TMPDIR=env["PI_FOREMAN_STATE_DIR"])
            direct = subprocess.run([sys.executable, "-E", "-s", str(LEDGER), "status"], env=direct_env, cwd=tmp, capture_output=True, text=True, timeout=60)
            self.assertEqual((via.returncode, via.stdout, via.stderr), (direct.returncode, direct.stdout, direct.stderr))
            self.assertIn("no ledger of its own", via.stderr)
            self.assertEqual(list(Path(tmp).glob("*.lock")), [])


if __name__ == "__main__":
    unittest.main()
