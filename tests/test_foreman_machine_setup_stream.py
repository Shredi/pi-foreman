"""machine setup streams the remote stderr while hc runs (a stub `hc` that waits for the first line to be shown), and still detects an hc timeout line."""
from __future__ import annotations

import io
import os
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

STUB = '''import os, sys, time
go = os.environ["STUB_GO_FILE"]
sys.stderr.write("first line\\n")
sys.stderr.flush()
for _ in range(100):
    if os.path.exists(go):
        break
    time.sleep(0.05)
else:
    sys.stderr.write("never released\\n")
    sys.exit(0)
sys.stderr.write("released\\n")
if os.environ.get("STUB_TIMEOUT"):
    sys.stderr.write("[hc] timed out after 5 ms\\n")
    sys.exit(0)
sys.stderr.write("partial without newline")
'''


class ReleasingStderr(io.StringIO):
    """Collects what is written; creates the stub's go file as soon as the first line arrives (proof the line was shown before hc exited)."""

    def __init__(self, go):
        super().__init__()
        self.go = go

    def write(self, s):
        n = super().write(s)
        if "first line" in self.getvalue() and not os.path.exists(self.go):
            Path(self.go).write_text("go", "utf-8")
        return n


class MachineSetupStreamTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="machine_setup_stream_")).resolve()
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        script = self.tmp / "stub_hc.py"
        script.write_text(STUB, "utf-8")
        if os.name == "nt":
            self.hc = self.tmp / "hc.bat"
            self.hc.write_text('@"%s" "%s" %%*\r\n' % (sys.executable, script), "utf-8")
        else:
            self.hc = self.tmp / "hc"
            self.hc.write_text('#!/bin/sh\nexec "%s" "%s" "$@"\n' % (sys.executable, script), "utf-8")
            self.hc.chmod(0o755)
        self.go = str(self.tmp / "go")

    def run_setup(self, timeout_line=False):
        args = mock.Mock(agent_dir=str(self.tmp), dry_run=False, timeout=None)
        args.name = "alpha"
        err = ReleasingStderr(self.go)
        env = {"STUB_GO_FILE": self.go, "STUB_TIMEOUT": "1" if timeout_line else ""}
        with mock.patch.object(fsn, "machine_entry", return_value=({}, ["foreman"])), \
                mock.patch.object(fsn, "hc_required", return_value=str(self.hc)), \
                mock.patch.object(fsn, "installed_addon_ids", return_value=[]), \
                mock.patch.dict(os.environ, env), \
                mock.patch.object(sys, "stderr", err), redirect_stdout(io.StringIO()):
            code = fsn.cmd_machine_setup(args)
        return code, err.getvalue()

    def test_stderr_line_is_shown_before_the_remote_command_exits(self):
        code, err = self.run_setup()
        self.assertEqual(code, 0, err)
        self.assertNotIn("never released", err)
        self.assertLess(err.index("first line"), err.index("released"))
        self.assertTrue(err.endswith("partial without newline\n"), err)
        self.assertNotIn("setup failed", err)

    def test_timeout_line_is_still_detected_in_streamed_text(self):
        code, err = self.run_setup(timeout_line=True)
        self.assertEqual(code, 1, err)
        self.assertIn("first line", err)
        self.assertIn("setup failed on alpha ([hc] timed out after 5 ms)", err)
        self.assertIn("foreman machine setup alpha", err)


class MachineSetupHeldStderrTest(unittest.TestCase):
    def test_grandchild_holding_stderr_does_not_hang_setup(self):
        tmp = Path(tempfile.mkdtemp(prefix="machine_setup_held_")).resolve()
        self.addCleanup(shutil.rmtree, str(tmp), True)
        stop = tmp / "stop"
        self.addCleanup(lambda: stop.write_text("x", "utf-8"))  # lets the grandchild end
        script = tmp / "stub_hc.py"
        script.write_text(
            "import os, subprocess, sys, time\n"
            "sys.stderr.write('[hc] timed out after 5 ms\\n')\n"
            "sys.stderr.flush()\n"
            "code = 'import os, time\\nfor _ in range(200):\\n    if os.path.exists(%r): break\\n    time.sleep(0.05)' % os.environ['STUB_STOP_FILE']\n"
            "subprocess.Popen([sys.executable, '-c', code])\n", "utf-8")
        if os.name == "nt":
            hc = tmp / "hc.bat"
            hc.write_text('@"%s" "%s" %%*\r\n' % (sys.executable, script), "utf-8")
        else:
            hc = tmp / "hc"
            hc.write_text('#!/bin/sh\nexec "%s" "%s" "$@"\n' % (sys.executable, script), "utf-8")
            hc.chmod(0o755)
        args = mock.Mock(agent_dir=str(tmp), dry_run=False, timeout=None)
        args.name = "alpha"
        err = io.StringIO()
        with mock.patch.object(fsn, "machine_entry", return_value=({}, ["foreman"])), \
                mock.patch.object(fsn, "hc_required", return_value=str(hc)), \
                mock.patch.object(fsn, "installed_addon_ids", return_value=[]), \
                mock.patch.object(fsn, "SETUP_READER_JOIN", 0.3), \
                mock.patch.dict(os.environ, {"STUB_STOP_FILE": str(stop)}), \
                mock.patch.object(sys, "stderr", err), redirect_stdout(io.StringIO()):
            code = fsn.cmd_machine_setup(args)
        self.assertEqual(code, 1, err.getvalue())
        self.assertIn("setup failed on alpha ([hc] timed out after 5 ms)", err.getvalue())


if __name__ == "__main__":
    unittest.main()
