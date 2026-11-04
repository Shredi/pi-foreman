"""Driver diagnostics: entry customTypes in the record tail, EOF fragments kept as bad lines.

The child is a plain Python process that prints canned stdout, so no Pi CLI is needed.
"""
from __future__ import annotations

import os
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import PiRpc  # noqa: E402

CODE = r"""
import sys
sys.stdout.write('{"type":"entry_appended","entry":{"customType":"stop-gate"}}\n')
sys.stdout.write('{"type":"message_end","message":{"role":"user","customType":"wake"}}\n')
sys.stdout.write('garbage line\n')
sys.stdout.write('{"type":"trunc')
sys.stdout.flush()
"""


class TestDiagnostics(unittest.TestCase):
    def test_entry_customtype_and_eof_fragment(self):
        p = PiRpc([sys.executable, "-c", CODE], cwd=Path.cwd(), env=dict(os.environ))
        try:
            deadline = time.time() + 20
            self.assertEqual(p._next(deadline)["type"], "entry_appended")
            self.assertEqual(p._next(deadline)["type"], "message_end")
            with self.assertRaises(EOFError) as cm:
                p._next(deadline)
        finally:
            p.close(timeout=20)
        msg = str(cm.exception)
        self.assertIn("pi exited (code", msg)
        self.assertIn("('entry_appended', 'stop-gate', None)", msg)
        self.assertIn("('message_end', 'wake', 'user')", msg)
        self.assertIn("unparseable stdout lines: 2", msg)
        self.assertIn('{"type":"trunc', msg)
        self.assertIn("garbage line", msg)


if __name__ == "__main__":
    unittest.main()
