"""Finding 123: the remote probe says why `pi --version` failed, retries once, and stays inside its deadline."""
from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))
from test_foreman_session_remote import RemoteBase, ADDRESS, install_script  # noqa: E402
import foreman_session as fsn  # noqa: E402


def done(code, out=b"", err=b""):
    return subprocess.CompletedProcess(["pi"], code, out, err)


class Left:
    """A deadline with a fixed time left."""

    def __init__(self, seconds):
        self.seconds = seconds

    def left(self):
        return self.seconds


class PiVersionReasonTest(unittest.TestCase):
    def run_with(self, results, deadline=None, which="/bin/pi"):
        with mock.patch.object(fsn.shutil, "which", return_value=which), \
                mock.patch.object(fsn.subprocess, "run", side_effect=results) as run:
            return fsn.pi_version_result(deadline), run

    def test_not_on_path(self):
        (version, why), run = self.run_with([], which=None)
        self.assertEqual((version, why), (None, "pi is not on PATH"))
        run.assert_not_called()

    def test_timeout_says_6_s_and_retries_once(self):
        (version, why), run = self.run_with([subprocess.TimeoutExpired("pi", 6)] * 3)
        self.assertIsNone(version)
        self.assertEqual(why, "pi --version timed out after 6 s")
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args.kwargs["timeout"], 6)

    def test_nonzero_exit_names_the_code_and_retries_once(self):
        (version, why), run = self.run_with([done(3), done(3), done(3)])
        self.assertEqual((version, why), (None, "pi --version exited 3 without output"))
        self.assertEqual(run.call_count, 2)

    def test_the_retry_can_succeed(self):
        (version, why), run = self.run_with([subprocess.TimeoutExpired("pi", 6), done(0, b"pi 1.2.3\n")])
        self.assertEqual((version, why), ("pi 1.2.3", None))
        self.assertEqual(run.call_count, 2)

    def test_no_retry_when_less_than_2_s_are_left(self):
        (version, why), run = self.run_with([subprocess.TimeoutExpired("pi", 1.5)] * 2, deadline=Left(1.5))
        self.assertIsNone(version)
        self.assertEqual(run.call_count, 1)

    def test_an_attempt_gets_at_most_what_is_left(self):
        _, run = self.run_with([done(0, b"pi 1\n")], deadline=Left(4))
        self.assertEqual(run.call_args.kwargs["timeout"], 4)


class ProbeDeadlineTest(RemoteBase):
    def probe(self, **env):
        return self.remote("probe", {"parentName": "beta", "parentAddress": ADDRESS}, **env)

    def test_the_probe_reply_carries_the_reason_and_the_verbs(self):
        install_script(self.pibin, "pi", "import sys\nsys.exit(3)\n")
        code, r = self.probe()
        self.assertEqual(code, 0)
        self.assertIsNone(r["piVersion"])
        self.assertIn("exited 3", r["piVersionError"])
        self.assertIn("restart", r["verbs"])

    def test_the_hc_status_call_shares_the_probe_deadline(self):
        seen = []
        real = fsn.hc_status
        with mock.patch.object(fsn, "hc_status", side_effect=lambda deadline=None: (seen.append(deadline), real(deadline))[1]):
            self.probe()
        self.assertEqual(len(seen), 1)
        self.assertIsNotNone(seen[0])
        self.assertLessEqual(seen[0].left(), fsn.PROBE_BUDGET)
        self.assertLess(fsn.PROBE_BUDGET, fsn.PROBE_TIMEOUT)

    def test_the_open_error_names_the_reason(self):
        install_script(self.pibin, "pi", "import sys\nsys.exit(3)\n")
        code, out, err = self.run_main(*self.open_args(machine="alpha"))
        self.assertEqual(code, 1)
        self.assertIn("exited 3", out + err)
        self.assertNotIn("pi was not found", out + err)


if __name__ == "__main__":
    unittest.main()
