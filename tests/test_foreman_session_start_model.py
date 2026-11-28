"""Remote open start model (scripts/foreman_session.py): a remote open without --model launches the child on the opener's
model (a start model, not pinned); the remote checks its Pi lists it first. Same fakes as test_foreman_session_remote.py,
plus a fake `pi` that answers `--list-models` (FAKE_PI_LIST: table (default) | fail | garbage | empty)."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))
from test_foreman_session_remote import RemoteBase, install_script, fsn  # noqa: E402

START = "anthropic/claude-sonnet-5-5"
FAKE_PI = r'''
import os, sys
a = sys.argv[1:]
if a[:1] == ["--list-models"]:
    mode = os.environ.get("FAKE_PI_LIST", "table")
    if mode == "fail":
        sys.stderr.write("boom\n")
        sys.exit(3)
    if mode == "garbage":
        print("something else")
    elif mode == "empty":
        print("No models matching x")
    else:
        print("provider   model               context  max-out  thinking  images")
        print("anthropic  claude-sonnet-5-5   200K     64K      yes       yes")
        print("anthropic  claude-opus-5-5     200K     64K      yes       yes")
        print("openai     gpt-9               200K     64K      yes       yes")
    sys.exit(0)
print("pi 9.9.9")
'''


class StartModelBase(RemoteBase):
    def setUp(self):
        super().setUp()
        install_script(self.pibin, "pi", FAKE_PI)
        self.env["FAKE_PI_LIST"] = ""

    def launch_of(self, reply):
        return (self.handoff(reply) / "launch.txt").read_text("utf-8")


class RemoteVerbTest(StartModelBase):
    def test_start_model_goes_on_the_command_line_and_the_start_env_only(self):
        reply = self.remote_open(startModel=START)
        launch = self.launch_of(reply)
        self.assertIn("--model", launch)
        self.assertIn(START, launch)
        self.assertIn("PI_FOREMAN_START_MODEL", launch)
        self.assertNotIn("PI_FOREMAN_SESSION_MODEL", launch)
        self.assertIsNone(self.remote_registry()[0]["model"])
        run = self.hc_calls("run")[0]
        argv = run[run.index("--") + 1:]
        self.assertIn(START, " ".join(argv))
        self.assertIn("PI_FOREMAN_START_MODEL", " ".join(argv))

    def test_explicit_model_is_unchanged_and_wins(self):
        reply = self.remote_open(model="openai/gpt-9", startModel=START)
        launch = self.launch_of(reply)
        self.assertIn("PI_FOREMAN_SESSION_MODEL", launch)
        self.assertIn("openai/gpt-9", launch)
        self.assertNotIn("PI_FOREMAN_START_MODEL", launch)
        self.assertNotIn(START, launch)
        self.assertEqual(self.remote_registry()[0]["model"], "openai/gpt-9")

    def test_no_model_no_start_model_is_unchanged(self):
        launch = self.launch_of(self.remote_open())
        self.assertNotIn("--model", launch)
        self.assertNotIn("PI_FOREMAN_START_MODEL", launch)

    def test_unknown_model_is_refused_and_nothing_is_spawned(self):
        for over in ({"startModel": "anthropic/claude-nope-1"}, {"model": "anthropic/claude-nope-1"},
                     {"startModel": "azure/claude-sonnet-5-5"}):
            rc, reply = self.remote("open", self.open_params(**over))
            self.assertEqual((rc, reply["code"]), (1, "model_unavailable"), over)
            self.assertIn(fsn.short_hostname(), reply["error"])
            self.assertIn(next(iter(over.values())), reply["error"])
            rc, reply = self.remote("open", self.open_params(dryRun=True, **over))
            self.assertEqual((rc, reply["code"]), (1, "model_unavailable"), over)
        self.assertEqual(self.hc_calls("run"), [])
        self.assertFalse((self.radir / "pi-foreman").exists())

    def test_known_model_dry_run_passes(self):
        rc, reply = self.remote("open", self.open_params(dryRun=True, startModel=START))
        self.assertEqual((rc, reply["status"]), (0, "dryRun"))

    def test_a_check_that_cannot_run_goes_on_with_a_line(self):
        for mode in ("fail", "garbage"):
            rc, reply = self.remote("open", self.open_params(startModel=START), FAKE_PI_LIST=mode)
            self.assertEqual(rc, 0, reply)
            self.assertIn("--model", self.launch_of(reply))
        with mock.patch.object(fsn.shutil, "which", return_value=None):
            lines = []
            fsn.check_launch_model(START, lines.append)
        self.assertEqual(len(lines), 1)
        self.assertIn("model not checked", lines[0])

    def test_timeout_goes_on(self):
        import subprocess
        with mock.patch.object(fsn.subprocess, "run", side_effect=subprocess.TimeoutExpired("pi", 20)):
            lines = []
            fsn.check_launch_model(START, lines.append)
        self.assertEqual(len(lines), 1)

    def test_powershell_command_carries_the_start_model(self):
        with mock.patch.object(fsn, "host_platform", return_value="win32"):
            reply = self.remote_open(startModel=START)
        run = self.hc_calls("run")[0]
        argv = run[run.index("--") + 1:]
        self.assertEqual(argv[:3], ["powershell", "-NoProfile", "-Command"])
        self.assertIn("; pi.cmd --model '%s'" % START, argv[3])
        self.assertIn("$env:PI_FOREMAN_START_MODEL='%s'" % START, argv[3])
        self.assertNotIn("PI_FOREMAN_SESSION_MODEL", argv[3])
        self.assertEqual(reply["status"], "open")

    def test_bad_start_model_is_a_bad_request(self):
        rc, reply = self.remote("open", self.open_params(startModel="a b"))
        self.assertEqual((rc, reply["code"]), (1, "bad_request"))

    def test_probe_advertises_the_feature(self):
        rc, r = self.remote("probe", {"parentName": "beta", "parentAddress": self.open_params()["parentAddress"]})
        self.assertEqual(rc, 0)
        self.assertIn("startModel", r["features"])


class ParentCliTest(StartModelBase):
    def sent(self):
        return json.loads(self.exec_calls()[1]["stdin"])

    def test_start_model_is_sent_when_the_probe_advertises_it(self):
        rc, out, err = self.run_main(*self.open_args("--start-model", START))
        self.assertEqual(rc, 0, err)
        self.assertEqual(self.sent()["startModel"], START)
        self.assertIsNone(self.sent()["model"])
        self.assertIsNone(self.parent_registry()[0]["model"])
        self.assertIn("PI_FOREMAN_START_MODEL", self.launch_of({"handoffName": Path(self.parent_registry()[0]["remoteHandoff"]).name}))

    def test_explicit_model_wins_and_start_model_is_not_sent(self):
        rc, out, err = self.run_main(*self.open_args("--model", "openai/gpt-9", "--start-model", START))
        self.assertEqual(rc, 0, err)
        self.assertNotIn("startModel", self.sent())

    def test_older_remote_gets_no_field_and_a_line(self):
        real = fsn.hc_exec_verb

        def old(binary, name, argv, verb, payload, timeout):
            reply = real(binary, name, argv, verb, payload, timeout)
            if verb == "probe":
                reply.pop("features", None)
            return reply

        with mock.patch.object(fsn, "hc_exec_verb", side_effect=old):
            rc, out, err = self.run_main(*self.open_args("--start-model", START))
        self.assertEqual(rc, 0, err)
        self.assertNotIn("startModel", self.sent())
        self.assertIn("start model not passed: update pi-foreman on alpha", out)

    def test_unknown_model_there_is_refused_at_open(self):
        rc, out, err = self.run_main(*self.open_args("--start-model", "anthropic/claude-nope-1"))
        self.assertEqual(rc, 1)
        self.assertIn("model_unavailable", err)
        self.assertEqual(self.hc_calls("run"), [])
        self.assertEqual(self.parent_registry(), [])

    def test_start_model_needs_machine(self):
        rc, out, err = self.run_main("open", "demo", str(self.brief), "--start-model", START, "--parent-id", "p")
        self.assertEqual(rc, 1)
        self.assertIn("--start-model needs --machine", err)


if __name__ == "__main__":
    unittest.main()
