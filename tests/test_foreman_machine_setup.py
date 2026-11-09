"""`foreman machine setup <name>`, installed_addon_ids and intercom_transport (remote-windows-2 item 7)."""
from __future__ import annotations

import io
import json
import shlex
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))
import test_foreman_session_remote as rt  # noqa: E402

fsn = rt.fsn


class MachineSetupTest(unittest.TestCase):
    def setUp(self):
        self.adir = Path(tempfile.mkdtemp(prefix="machine_setup_")).resolve()
        self.addCleanup(shutil.rmtree, str(self.adir), True)

    def settings(self, packages):
        (self.adir / "settings.json").write_text(json.dumps({"packages": packages}), "utf-8")

    def test_installed_addon_ids_match_packages_by_source(self):
        self.settings(["npm:pi-polish@0.1.2", {"source": "git:github.com/x/pi-background-tasks"}, "npm:pi-polish-extra"])
        ids = fsn.installed_addon_ids(self.adir)
        self.assertIn("polish", ids)
        self.assertIn("background-tasks", ids)
        self.assertEqual(ids, sorted(ids))
        self.assertEqual(len(ids), 2)

    def test_installed_addon_ids_without_settings(self):
        self.assertEqual(fsn.installed_addon_ids(self.adir), [])

    def test_intercom_transport(self):
        self.assertIsNone(fsn.intercom_transport(self.adir))
        (self.adir / "intercom").mkdir()
        (self.adir / "intercom" / "config.json").write_text(json.dumps({"crossMachine": {"transport": "hc"}}), "utf-8")
        self.assertEqual(fsn.intercom_transport(self.adir), "hc")

    def test_dry_run_prints_the_hc_exec_command(self):
        self.settings(["npm:pi-polish"])
        args = mock.Mock(agent_dir=str(self.adir), name="x", dry_run=True)
        args.name = "alpha"
        with mock.patch.object(fsn, "machine_entry", return_value=({}, ["foreman"])), \
                mock.patch.object(fsn, "hc_required", return_value="/bin/hc"), \
                mock.patch.object(fsn.subprocess, "call") as call, redirect_stdout(io.StringIO()) as out:
            rc = fsn.cmd_machine_setup(args)
        self.assertEqual(rc, 0)
        call.assert_not_called()
        self.assertEqual(shlex.split(out.getvalue()), ["/bin/hc", "exec", "--on", "alpha", "--timeout", "600", "--", "foreman", "setup", "--addon", "polish",
                                                       "--intercom-hc", "--machine-name", "alpha"])

    def test_run_calls_hc(self):
        self.settings([])
        args = mock.Mock(agent_dir=str(self.adir), dry_run=False)
        args.name = "alpha"
        with mock.patch.object(fsn, "machine_entry", return_value=({}, ["foreman"])), \
                mock.patch.object(fsn, "hc_required", return_value="/bin/hc"), \
                mock.patch.object(fsn.subprocess, "call", return_value=0) as call:
            self.assertEqual(fsn.cmd_machine_setup(args), 0)
        self.assertEqual(call.call_args.args[0][-3:], ["--intercom-hc", "--machine-name", "alpha"])


if __name__ == "__main__":
    unittest.main()
