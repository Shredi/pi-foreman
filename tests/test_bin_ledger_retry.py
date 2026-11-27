"""bin/ledger reruns ledger.py on a Windows access-denied rename, bounded."""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SHIM = Path(__file__).resolve().parent.parent / "bin" / "ledger"
MARKER = "ledger: [WinError 5] Access is denied"


@unittest.skipUnless(shutil.which("sh"), "sh not available")
class BinLedgerRetryTest(unittest.TestCase):
    def run_shim(self, fail_runs, message, code=1):
        """Fake interpreter fails `fail_runs` times (None = always); returns (proc, runs, leftovers)."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            state = tmp / "state"
            state.mkdir()
            counter = tmp / "counter"
            fake = tmp / "fakepy"
            limit = "999999" if fail_runs is None else str(fail_runs)
            fake.write_text(
                "#!/bin/sh\n"
                # the lock helper's read-only resolver run (python -c) resolves nothing and is no ledger.py run
                'case "$*" in *" -c "*) exit 0;; esac\n'
                f"echo x >> '{counter}'\n"
                f"n=$(wc -l < '{counter}')\n"
                f"if [ \"$n\" -le {limit} ]; then echo '{message}' >&2; exit {code}; fi\n"
                "echo ok\n"
            )
            fake.chmod(0o755)
            env = dict(os.environ, PI_FOREMAN_PYTHON=str(fake), PI_FOREMAN_STATE_DIR=str(state))
            if os.name == "nt":
                # Node cannot start a shebang script on Windows (a real install names an interpreter .exe), so the shim's own
                # sh retry loop is the subject here: no node on its PATH (the Node helper's rerun: test_ledger_run_bytes.py)
                env["PATH"] = os.pathsep.join(d for d in env["PATH"].split(os.pathsep) if not os.path.exists(os.path.join(d, "node.exe")))
                env["PI_CODING_AGENT_DIR"] = str(tmp / "agent")
            proc = subprocess.run(
                ["sh", str(SHIM), "mark", "1"], env=env, capture_output=True, text=True, timeout=30
            )
            runs = len(counter.read_text(encoding="utf-8").splitlines())
            return proc, runs, list(state.iterdir())

    def test_marker_twice_then_success(self):
        proc, runs, left = self.run_shim(2, MARKER)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "ok")
        self.assertEqual(runs, 3)
        self.assertEqual(left, [])

    def test_always_marker_stops_at_ten_runs(self):
        proc, runs, left = self.run_shim(None, MARKER)
        self.assertEqual(proc.returncode, 1)
        self.assertIn(MARKER, proc.stderr)
        self.assertEqual(runs, 10)
        self.assertEqual(left, [])

    def test_plain_refusal_runs_once(self):
        proc, runs, left = self.run_shim(None, "ledger: item 9 not found")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("ledger: item 9 not found", proc.stderr)
        self.assertEqual(runs, 1)
        self.assertEqual(left, [])


if __name__ == "__main__":
    unittest.main()
