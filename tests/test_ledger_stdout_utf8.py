"""D213: ledger.py writes UTF-8 on stdout even when the interpreter's own stdout encoding is cp1252 (Windows, where `python -E`
drops PYTHONUTF8), so the adapter's UTF-8 decode of a note echo keeps the em dash."""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

LEDGER = Path(__file__).resolve().parent.parent / "core" / "scripts" / "ledger.py"


class LedgerStdoutUtf8Test(unittest.TestCase):
    def test_note_echo_is_utf8_under_a_cp1252_stdout(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp) / "LEDGER.md"
            ledger.write_text("- [ ] 1. first\n- [ ] V. verify\n", encoding="utf-8")
            env = {k: v for k, v in os.environ.items() if k not in ("PYTHONUTF8", "PYTHONIOENCODING")}
            env["PYTHONIOENCODING"] = "cp1252"  # stdout.encoding is cp1252 here, as on Windows under -E
            probe = subprocess.run([sys.executable, "-c", "import sys; print(sys.stdout.encoding)"], env=env, capture_output=True, text=True)
            self.assertEqual(probe.stdout.strip(), "cp1252")
            proc = subprocess.run([sys.executable, str(LEDGER), "-f", str(ledger), "note", "1", "a — b"], env=env, capture_output=True, timeout=60)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("a — b".encode("utf-8"), proc.stdout)
            self.assertNotIn(b"\x97", proc.stdout)
            self.assertIn("a — b", ledger.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
