"""D104: `machine setup --dry-run` works before the machine is in the config and lists the remote changes."""
from __future__ import annotations

import io
import shlex
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))
import test_foreman_session_remote as rt  # noqa: E402

fsn = rt.fsn


class MachineSetupDryRunTest(unittest.TestCase):
    def setUp(self):
        self.adir = Path(tempfile.mkdtemp(prefix="machine_setup_dry_")).resolve()
        self.addCleanup(shutil.rmtree, str(self.adir), True)

    def run_dry(self, listed, hc_ok=True, dry_run=True):
        args = mock.Mock(agent_dir=str(self.adir), dry_run=dry_run, timeout=None)
        args.name = "alpha"
        entry = mock.Mock(return_value=({}, ["foreman"])) if listed else mock.Mock(side_effect=fsn.Refused("machine alpha is not in sessions.machines"))
        check = mock.Mock() if hc_ok else mock.Mock(side_effect=fsn.Refused("hc does not know alpha"))
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(fsn, "machine_entry", entry), mock.patch.object(fsn, "hc_required", return_value="/bin/hc"), \
                mock.patch.object(fsn, "check_hc_machine", check), \
                mock.patch.object(fsn.subprocess, "call", return_value=0) as call, redirect_stdout(out), redirect_stderr(err):
            try:
                rc = fsn.cmd_machine_setup(args)
            except fsn.Refused as e:
                rc = e
        return rc, out.getvalue(), err.getvalue(), call

    def test_dry_run_without_config_is_not_refused(self):
        rc, out, err, call = self.run_dry(listed=False)
        self.assertEqual(rc, 0)
        self.assertIn("not in config; the real run would refuse", out)
        self.assertEqual(shlex.split(out.splitlines()[0])[:5], ["/bin/hc", "exec", "--on", "alpha", "--timeout"])
        call.assert_called_once()

    def test_the_real_run_without_config_still_refuses(self):
        rc, out, err, call = self.run_dry(listed=False, dry_run=False)
        self.assertIsInstance(rc, fsn.Refused)
        call.assert_not_called()

    def test_remote_changes_are_listed_from_the_remote_dry_run(self):
        rc, out, err, call = self.run_dry(listed=True)
        self.assertEqual(rc, 0)
        self.assertIn("remote changes on alpha", out)
        self.assertEqual(call.call_args.args[0][-1], "--dry-run")
        self.assertIn("--intercom-hc", call.call_args.args[0])

    def test_a_machine_hc_does_not_know_prints_the_command_and_says_the_changes_are_not_listed(self):
        rc, out, err, call = self.run_dry(listed=True, hc_ok=False)
        self.assertEqual(rc, 0)
        self.assertIn("the remote changes are not listed", err)
        call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
