"""The status line printed in a new pane before Pi starts (scripts/foreman_session.py)."""
from __future__ import annotations

import shlex
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_foreman_session as base  # noqa: E402

fsn = base.fsn
ENV = [("PI_FOREMAN_HANDOFF_DIR", "/h")]
ODD = "it's \"x\" é"


class StartBannerTest(unittest.TestCase):
    def test_text_local_remote_and_without_model(self):
        self.assertEqual(fsn.start_banner("demo", "prov/m1", None, "/h/brief.md"),
                         "pi-foreman: starting session demo (prov/m1) on this computer, brief /h/brief.md ...")
        self.assertEqual(fsn.start_banner("demo", None, "box", "/h/brief.md"),
                         "pi-foreman: starting session demo on box, brief /h/brief.md ...")

    def test_ascii_single_line_and_no_env_values(self):
        text = fsn.start_banner("d\nemo", ODD, "m\u00e9", "/p ath/\u2019x")
        self.assertTrue(text.isascii() and "\n" not in text, text)
        self.assertNotIn("PI_FOREMAN", text)

    def test_posix_command_prints_then_runs_pi_even_if_printf_fails(self):
        banner = fsn.start_banner("demo", ODD, None, "/p ath/b'rief.md")
        cmd = fsn.posix_command(ENV, ODD, "go", (), banner)
        self.assertTrue(cmd.startswith("printf '%s\\n' "), cmd)
        head, rest = cmd.split("; ", 1)
        self.assertEqual(shlex.split(head)[2], banner)
        self.assertTrue(rest.startswith("env PI_FOREMAN_HANDOFF_DIR=/h pi --model "), rest)
        self.assertNotIn("&&", cmd)
        self.assertEqual(fsn.posix_command(ENV, None, "go", ()), fsn._posix_command(ENV, None, "go", ()))

    def test_powershell_command_prints_then_runs_pi(self):
        banner = fsn.start_banner("demo", ODD, "box", "C:\\a b\\it's\\brief.md")
        cmd = fsn.powershell_command(ENV, None, "go", (), banner=banner)
        self.assertTrue(cmd.startswith("Write-Host 'pi-foreman: starting session demo (it''s \"x\" ?) on box, brief C:\\a b\\it''s"), cmd)
        self.assertIn("; $env:PI_FOREMAN_HANDOFF_DIR='/h'; pi ", cmd)
        self.assertNotIn("&&", cmd)
        self.assertEqual(fsn.powershell_command(ENV, None, "go", ()), "$env:PI_FOREMAN_HANDOFF_DIR='/h'; pi 'go'")

    def test_hc_argv_posix_wrapper_runs_the_same_argv(self):
        banner = fsn.start_banner("demo", "m", "box", "/h/brief.md")
        argv = fsn.hc_child_argv(ENV, "m", "go", (), "linux", "/bin", banner=banner)
        plain = fsn.hc_child_argv(ENV, "m", "go", (), "linux", "/bin")
        self.assertEqual(argv[:4], ["sh", "-c", 'printf "%s\\n" "$1"; shift; exec "$@"', "sh"])
        self.assertEqual((argv[4], argv[5:]), (banner, plain))
        # the wrapper really prints the line and then execs (a stand-in for env/pi)
        out = subprocess.run(["sh", "-c", argv[2], "sh", banner, "echo", "started"], capture_output=True, text=True)
        self.assertEqual(out.stdout, banner + "\nstarted\n")

    def test_hc_argv_win32_powershell_and_remote_pi_cmd(self):
        banner = fsn.start_banner("demo", None, "box", "C:\\h\\brief.md")
        argv = fsn.hc_child_argv(ENV, None, "go", (), "win32", "C:\\bin", "pi.cmd", banner)
        self.assertEqual(argv[:3], ["powershell", "-NoProfile", "-Command"])
        self.assertIn("; Write-Host 'pi-foreman: starting session demo on box, brief C:\\h\\brief.md ...'; $env:PI_FOREMAN", argv[3])
        self.assertTrue(argv[3].endswith("; pi.cmd 'go'"), argv[3])


if __name__ == "__main__":
    unittest.main()
