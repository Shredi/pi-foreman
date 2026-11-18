"""scripts/foreman_session.py: the child finds `pi` without the opener's PATH (PI_FOREMAN_PI_ARGV), and an open under herdr-core
checks that the child started (PI_FOREMAN_START_CHECK_SECONDS). Uses the fake `hc` of tests/fakes/hc.py."""
from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TESTS = Path(__file__).resolve().parent
SCRIPTS = TESTS.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(TESTS))
sys.path.insert(0, str(TESTS / "fakes"))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_session as fsn  # noqa: E402
from hc_install import install_fake_hc  # noqa: E402
from test_foreman_session_remote import RemoteBase  # noqa: E402

REAL_WHICH = shutil.which
NODE = "/opt/fake/bin/node"
CLI = "/opt/fake/lib/cli.js"
PI_ARGV = json.dumps([NODE, CLI])
ENV = [("PI_FOREMAN_HANDOFF_DIR", "/h")]


def no_pi(name, *a, **k):
    return None if name == "pi" else REAL_WHICH(name, *a, **k)


def pi_at(path):
    return lambda name, *a, **k: path if name == "pi" else REAL_WHICH(name, *a, **k)


class PiFallbackTest(unittest.TestCase):
    def argv(self, which, var=PI_ARGV, platform="linux", pi_word="pi"):
        env = {"PI_FOREMAN_PI_ARGV": var} if var is not None else {}
        with mock.patch.dict(os.environ, env), mock.patch.object(fsn.shutil, "which", which):
            if var is None:
                os.environ.pop("PI_FOREMAN_PI_ARGV", None)
            return fsn.hc_child_argv(ENV, "p/m", "prompt", (), platform, "/bin", pi_word)

    def test_no_pi_on_path_uses_the_running_pis_words(self):
        argv = self.argv(no_pi)
        i = argv.index(NODE)
        self.assertEqual(argv[i:i + 4], [NODE, CLI, "--model", "p/m"])
        self.assertNotIn("pi", argv)

    def test_no_pi_and_no_variable_keeps_the_bare_word(self):
        argv = self.argv(no_pi, var=None)
        self.assertIn("pi", argv)
        self.assertNotIn(NODE, argv)

    def test_a_pi_on_path_wins_over_the_variable(self):
        argv = self.argv(pi_at("/opt/x/pi"))
        self.assertIn("/opt/x/pi", argv)
        self.assertNotIn(NODE, argv)

    def test_a_malformed_variable_is_ignored(self):
        for bad in ("not json", "[]", '["a", 3]', '"x"', '[""]'):
            self.assertIn("pi", self.argv(no_pi, var=bad), bad)

    def test_posix_command_quotes_the_words(self):
        words = json.dumps(["/path with space/node", CLI])
        with mock.patch.dict(os.environ, {"PI_FOREMAN_PI_ARGV": words}), mock.patch.object(fsn.shutil, "which", no_pi):
            cmd = fsn.posix_command(ENV, "p/m", "prompt")
        self.assertIn("'/path with space/node' %s --model p/m" % CLI, cmd)
        with mock.patch.dict(os.environ, {"PI_FOREMAN_PI_ARGV": words}), mock.patch.object(fsn.shutil, "which", pi_at("/x/pi")):
            self.assertIn(" pi --model p/m", fsn.posix_command(ENV, "p/m", "prompt"))

    def test_powershell_command_uses_the_call_operator(self):
        words = json.dumps(["C:\\Program Files\\nodejs\\node.exe", "C:\\it's\\cli.js"])
        with mock.patch.dict(os.environ, {"PI_FOREMAN_PI_ARGV": words}), mock.patch.object(fsn.shutil, "which", no_pi):
            cmd = fsn.powershell_command(ENV, "p/m", "prompt")
            remote = fsn.powershell_command(ENV, "p/m", "prompt", pi_word="pi.cmd")
        self.assertIn("& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\it''s\\cli.js' --model 'p/m'", cmd)
        self.assertIn("; pi.cmd --model 'p/m'", remote)  # a remote Windows child keeps pi.cmd
        self.assertNotIn("&", remote)

    def test_win32_argv_carries_the_call_operator(self):
        argv = self.argv(no_pi, platform="win32")
        self.assertIn("& '%s' '%s' --model 'p/m'" % (NODE, CLI), argv[-1])


class StartCheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="session_start_check_")).resolve()
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.agent = self.tmp / "agent"
        self.proj = self.tmp / "proj"
        self.proj.mkdir()
        subprocess.run(["git", "init", "-q", str(self.proj)], check=True)
        self.brief = self.tmp / "brief.md"
        self.brief.write_text("# Task\n\nDo the thing.\n", "utf-8")
        self.hcbin = install_fake_hc(self.tmp / "hcbin")
        self.log = self.tmp / "hc.log"
        self.env = {"PI_CODING_AGENT_DIR": str(self.agent), "FAKE_HC_LOG": str(self.log), "FAKE_HC_STATE": str(self.tmp / "state"),
                    "HC_TERMINAL_ID": "t1", "HC_BIN": str(self.hcbin / ("hc.cmd" if os.name == "nt" else "hc"))}
        for k in ("HERDR_PANE_ID", "HERDR_BIN", "HC_SCOPE", "HC_TERMINAL_SOCKET", "PI_INTERCOM_STABLE_ID", "PI_INTERCOM_SESSION_ID",
                  "PI_FOREMAN_HANDOFF_DIR", "FAKE_HC_FAIL", "FAKE_HC_RUN_EXIT", "FAKE_HC_RUN_TEXT", "PI_FOREMAN_START_CHECK_SECONDS"):
            self.env[k] = ""

    def open(self, **env):
        e = dict(self.env, **env)
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, e), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                mock.patch.object(fsn.shutil, "which", no_pi):
            for k, v in e.items():
                if v == "":
                    os.environ.pop(k, None)
            code = fsn.main(["open", "demo", str(self.brief), "--cwd", str(self.proj), "--parent-id", "parent-1"])
        return code, out.getvalue(), err.getvalue()

    def calls(self, verb):
        lines = self.log.read_text("utf-8").splitlines() if self.log.exists() else []
        return [c for c in (json.loads(l) for l in lines) if c[:1] == [verb]]

    def registry(self):
        return json.loads((self.agent / "pi-foreman" / "state" / "sessions.json").read_text("utf-8"))["sessions"]

    def test_a_child_that_exits_at_once_is_an_error_not_opened(self):
        text = "\n".join("line %d" % i for i in range(1, 26))
        code, out, err = self.open(PI_FOREMAN_START_CHECK_SECONDS="0.1", FAKE_HC_RUN_EXIT="127", FAKE_HC_RUN_TEXT=text)
        self.assertEqual(code, 2, err)
        self.assertNotIn("opened under herdr-core", out)
        self.assertIn("session demo did not start: exit 127", err)
        self.assertIn("line 25", err)
        self.assertIn("line 6", err)
        self.assertNotIn("line 5\n", err + "\n")  # only the last 20 lines
        self.assertEqual(self.registry()[0]["status"], "failed")
        self.assertEqual(len(self.calls("get")), 1)
        self.assertEqual(len(self.calls("read")), 1)

    def test_a_live_child_is_opened(self):
        code, out, err = self.open(PI_FOREMAN_START_CHECK_SECONDS="0.1")
        self.assertEqual(code, 0, err)
        self.assertIn("opened under herdr-core", out)
        self.assertEqual(self.registry()[0]["status"], "open")
        self.assertEqual(len(self.calls("get")), 1)
        self.assertEqual(self.calls("read"), [])

    def test_without_the_variable_or_with_zero_nothing_is_checked(self):
        for value in ("", "0", "-1", "abc"):
            self.log.unlink(missing_ok=True)
            shutil.rmtree(self.agent, ignore_errors=True)
            with self.subTest(value=value):
                code, out, err = self.open(PI_FOREMAN_START_CHECK_SECONDS=value, FAKE_HC_RUN_EXIT="127")
                self.assertEqual(code, 0, err)
                self.assertIn("opened under herdr-core", out)
                self.assertEqual(self.calls("get"), [])


class RemoteStartCheckTest(RemoteBase):
    def test_a_remote_open_is_not_checked(self):
        code, reply = self.remote("open", self.open_params(), PI_FOREMAN_START_CHECK_SECONDS="0.1", FAKE_HC_RUN_EXIT="127")
        self.assertEqual((code, reply["ok"]), (0, True), reply)
        self.assertEqual(self.hc_calls("read"), [])
        self.assertEqual(self.remote_registry()[0]["status"], "open")


class LauncherTest(unittest.TestCase):
    def read(self, name):
        return (TESTS.parent / "bin" / name).read_text("utf-8")

    def test_the_launchers_set_the_start_check_for_session_unless_set(self):
        self.assertRegex(self.read("foreman"), r'session\) script=[^\n]*export PI_FOREMAN_START_CHECK_SECONDS="\$\{PI_FOREMAN_START_CHECK_SECONDS:-3\}"')
        self.assertIn('if /i "%~1"=="session" if not defined PI_FOREMAN_START_CHECK_SECONDS set "PI_FOREMAN_START_CHECK_SECONDS=3"', self.read("foreman.cmd"))
        self.assertRegex(self.read("foreman.ps1"), r"'session' \{[^\n]*if \(-not \$env:PI_FOREMAN_START_CHECK_SECONDS\) \{ \$env:PI_FOREMAN_START_CHECK_SECONDS = '3' \}")


if __name__ == "__main__":
    unittest.main()
