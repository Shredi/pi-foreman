"""bin/ledger-run.mjs hands ledger.py's stdout and stderr on as the bytes it wrote (no decode and re-encode), and reruns
on the Windows access-denied marker, with a fake ledger.py started by a real interpreter on every OS."""

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HELPER = Path(__file__).resolve().parent.parent / "bin" / "ledger-run.mjs"

# bytes that are not valid UTF-8 (0x97 is the em dash of cp1252) on both streams, then the exit code from argv
FAKE_BYTES = (
    "import sys\n"
    "sys.stdout.buffer.write(b'out \\x97 \\xff\\n'); sys.stdout.flush()\n"
    "sys.stderr.buffer.write(b'err \\x97 \\xc3\\n'); sys.stderr.flush()\n"
    "sys.exit(3)\n"
)

# fails with the marker until the counter file holds `argv[1]` runs
FAKE_RETRY = (
    "import sys\n"
    "c = sys.argv[2]\n"
    "open(c, 'a').write('x\\n')\n"
    "n = len(open(c).read().splitlines())\n"
    "if n <= int(sys.argv[1]):\n"
    "    sys.stderr.write('ledger: [WinError 5] Access is denied\\n'); sys.exit(1)\n"
    "print('ok')\n"
)


@unittest.skipUnless(shutil.which("node"), "node is needed")
class LedgerRunBytesTest(unittest.TestCase):
    def run_helper(self, script_text, *args):
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "fake_ledger.py"
            script.write_text(script_text, encoding="utf-8")
            proc = subprocess.run(
                ["node", "--no-warnings", "--experimental-strip-types", str(HELPER), str(script), sys.executable, "--", *args],
                capture_output=True,
                timeout=60,
            )
            return proc

    def test_output_bytes_and_exit_code_pass_through(self):
        proc = self.run_helper(FAKE_BYTES)
        self.assertEqual(proc.stdout, b"out \x97 \xff\n")
        self.assertEqual(proc.stderr, b"err \x97 \xc3\n")
        self.assertEqual(proc.returncode, 3)

    def test_access_denied_marker_is_rerun(self):
        with tempfile.TemporaryDirectory() as tmp:
            counter = str(Path(tmp) / "counter")
            proc = self.run_helper(FAKE_RETRY, "2", counter)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(proc.stdout.strip(), b"ok")
            self.assertEqual(len(Path(counter).read_text(encoding="utf-8").splitlines()), 3)


if __name__ == "__main__":
    unittest.main()
