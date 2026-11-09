"""machine setup: no installed add-on here means `--no-addons` on the remote."""
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_foreman_machine_setup as base  # noqa: E402

fsn = base.fsn


class MachineSetupNoAddonsTest(unittest.TestCase):
    def setUp(self):
        self.adir = Path(tempfile.mkdtemp(prefix="machine_setup_na_")).resolve()
        self.addCleanup(shutil.rmtree, str(self.adir), True)

    def argv(self, packages):
        (self.adir / "settings.json").write_text(json.dumps({"packages": packages}), "utf-8")
        args = mock.Mock(agent_dir=str(self.adir), dry_run=True)
        args.name = "alpha"
        with mock.patch.object(fsn, "machine_entry", return_value=({}, ["foreman"])), \
                mock.patch.object(fsn, "hc_required", return_value="/bin/hc"), redirect_stdout(io.StringIO()) as out:
            fsn.cmd_machine_setup(args)
        return shlex.split(out.getvalue())

    def test_empty_addons_pass_no_addons(self):
        argv = self.argv([])
        self.assertIn("--no-addons", argv)
        self.assertNotIn("--addon", argv)

    def test_installed_addons_do_not_pass_no_addons(self):
        argv = self.argv(["npm:pi-polish"])
        self.assertNotIn("--no-addons", argv)
        self.assertIn("--addon", argv)


if __name__ == "__main__":
    unittest.main()
