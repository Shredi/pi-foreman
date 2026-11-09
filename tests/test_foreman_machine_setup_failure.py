"""machine setup: `hc exec --timeout 600`; a nonzero exit or an hc timeout line is a failed setup with the rerun command."""
from __future__ import annotations

import io
import shlex
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_foreman_machine_setup as base  # noqa: E402

fsn = base.fsn


class MachineSetupFailureTest(unittest.TestCase):
    def run_setup(self, rc, stderr_text="", timeout=None, dry_run=False):
        args = mock.Mock(agent_dir="/nonexistent-agent-dir", dry_run=dry_run, timeout=timeout)
        args.name = "alpha"

        def call(cmd, stderr=None, **kw):
            self.cmd = cmd
            if stderr is not None:
                stderr.write(stderr_text.encode())
            return rc

        err, out = io.StringIO(), io.StringIO()
        with mock.patch.object(fsn, "machine_entry", return_value=({}, ["foreman"])), \
                mock.patch.object(fsn, "hc_required", return_value="/bin/hc"), \
                mock.patch.object(fsn, "installed_addon_ids", return_value=[]), \
                mock.patch.object(fsn.subprocess, "call", side_effect=call), redirect_stderr(err), redirect_stdout(out):
            code = fsn.cmd_machine_setup(args)
        return code, out.getvalue(), err.getvalue()

    def test_default_timeout_is_600(self):
        code, out, err = self.run_setup(0)
        self.assertEqual(code, 0)
        self.assertEqual(self.cmd[:7], ["/bin/hc", "exec", "--on", "alpha", "--timeout", "600", "--"])
        self.assertNotIn("setup failed", err)

    def test_timeout_option_is_capped_at_600(self):
        self.run_setup(0, timeout=900)
        self.assertEqual(self.cmd[5], "600")
        self.run_setup(0, timeout=120)
        self.assertEqual(self.cmd[5], "120")

    def test_dry_run_shows_the_timeout(self):
        code, out, err = self.run_setup(0, dry_run=True)
        self.assertEqual(shlex.split(out)[4:6], ["--timeout", "600"])

    def test_nonzero_exit_is_a_failed_setup_with_the_rerun_command(self):
        code, out, err = self.run_setup(2)
        self.assertEqual(code, 2)
        self.assertIn("setup failed on alpha", err)
        self.assertIn("foreman machine setup alpha", err)

    def test_an_hc_timeout_line_fails_even_with_exit_zero(self):
        code, out, err = self.run_setup(0, "[hc] timed out after 600000 ms\n")
        self.assertNotEqual(code, 0)
        self.assertIn("[hc] timed out after 600000 ms", err)
        self.assertIn("setup failed on alpha", err)
        self.assertIn("foreman machine setup alpha", err)


if __name__ == "__main__":
    unittest.main()
