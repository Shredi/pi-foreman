"""Ledger item 6, the kept behaviour: a variable set in an earlier call cannot be resolved by a guard that sees one command, so a write through it is
refused as unresolved, for a child's own handoff name and for a parent's ruling alike. The refusal names the token and the way out (the write tool)."""
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import shell_write_guard as swg  # noqa: E402


class EarlierCallVariable(unittest.TestCase):
    def setUp(self):
        base = os.path.realpath(tempfile.mkdtemp(prefix="pf-swg-rp-"))
        self.addCleanup(shutil.rmtree, base, True)
        self.ws = os.path.join(base, "ws").replace(os.sep, "/")
        self.h = os.path.join(base, "agent", "handoffs", "h1").replace(os.sep, "/")
        os.makedirs(self.ws)
        os.makedirs(os.path.join(self.h, "work"))

    def run_main(self, command, handoff):
        payload = {"tool_input": {"command": command}, "cwd": self.ws, "workspace": self.ws}
        if handoff:
            payload["handoff_dir"] = self.h
        out = io.StringIO()
        with mock.patch.object(sys, "stdin", mock.Mock(buffer=io.BytesIO(json.dumps(payload).encode()))), redirect_stdout(out):
            self.assertEqual(swg.main([]), 0)
        return json.loads(out.getvalue().strip().splitlines()[-1])

    def test_child_result_through_an_earlier_variable_is_unresolved(self):
        for command in ('echo x > "$D/result.md"', 'cp a.txt "${D}/result.md"'):
            with self.subTest(command=command):
                hit = swg.decide(command, self.ws, self.ws, "bash", None, None, None, self.h)
                self.assertIsNotNone(hit)
                self.assertTrue(hit[1].endswith("(unresolved)"), hit)
                self.assertTrue(hit.unresolved)
                self.assertFalse(hit.handoff)
                out = self.run_main(command, True)
                reason = out["hookSpecificOutput"]["permissionDecisionReason"]
                self.assertIn("D", reason)
                self.assertIn("write tool", reason)
                self.assertTrue(out["unresolved"])

    def test_parent_ruling_through_an_earlier_variable_is_unresolved(self):
        for command, token in (('echo ok > "$D/ruling.md"', "$D"), ('cp r.md "${D}/ruling-1.md"', "${D}")):
            with self.subTest(command=command):
                hit = swg.decide(command, self.ws, self.ws, "bash", None, None, None, None)
                self.assertIsNotNone(hit)
                self.assertTrue(hit[1].endswith("(unresolved)"), hit)
                self.assertTrue(hit.unresolved)
                out = self.run_main(command, False)
                reason = out["hookSpecificOutput"]["permissionDecisionReason"]
                self.assertIn(token, reason)
                self.assertIn("write tool", reason)

    def test_the_harness_variable_resolves(self):
        self.assertIsNone(swg.decide('echo x > "$PI_FOREMAN_HANDOFF_DIR/result.md"', self.ws, self.ws, "bash", None, None, None, self.h))


if __name__ == "__main__":
    unittest.main()
