"""D217: `foreman_session.py open` on the herdr backend confirms that Pi started. A fake `herdr` answers `pane process-info` and
`pane read` per FAKE_MODE; live.json is written by the fake the way the child's adapter would."""
from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_foreman_session as base  # noqa: E402

FAKE = base.FAKE.replace('else:\n    out = {"result": {}}', r'''elif key == "pane process-info":
    mode = os.environ.get("FAKE_MODE", "")
    counter = os.environ["FAKE_HERDR_LOG"] + ".n"
    n = (int(open(counter).read()) if os.path.exists(counter) else 0) + 1
    open(counter, "w").write(str(n))
    if (mode == "live" and n >= 2) or (mode == "slow" and n >= 7):
        for d in os.listdir(os.environ["FAKE_HANDOFFS"]):
            open(os.path.join(os.environ["FAKE_HANDOFFS"], d, "live.json"), "w").write(json.dumps({"intercomId": "fm-x", "piSessionId": "s"}))
    shell_only = (mode == "exit" and n >= 2) or (mode == "slow" and n <= 4)
    out = {"result": {"process_info": {"shell_pid": 100, "foreground_process_group_id": 200, "foreground_processes": [{"pid": 100 if shell_only else 200}]}}}
elif key == "pane read":
    out = {"result": {"read": {"text": os.environ.get("FAKE_PANE_TEXT", ""), "source": "recent"}}}
else:
    out = {"result": {}}''')
assert FAKE != base.FAKE


class HerdrConfirmTest(unittest.TestCase):
    # the rig of SessionTest without its tests
    run_main, calls, registry, open_args = (base.SessionTest.run_main, base.SessionTest.calls, base.SessionTest.registry, base.SessionTest.open_args)

    def setUp(self):
        base.SessionTest.setUp(self)
        (self.tmp / "bin" / "herdr_fake.py").write_text(FAKE, "utf-8")
        self.env.update({"PI_FOREMAN_START_CONFIRM_SECONDS": "3", "PI_FOREMAN_START_CONFIRM_POLL": "0.02",
                         "FAKE_HANDOFFS": str(self.agent / "pi-foreman" / "handoffs"), "FAKE_MODE": "", "FAKE_PANE_TEXT": ""})

    def process_info_calls(self):
        return [c for c in self.calls() if c[:2] == ["pane", "process-info"]]

    def test_live_json_confirms_the_open(self):
        code, out, err = self.run_main(*self.open_args(), FAKE_MODE="live")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.registry()[0]["status"], "open")
        self.assertGreaterEqual(len(self.process_info_calls()), 2)

    def test_slow_shell_start_is_not_a_failure(self):
        # shell only for four polls, then Pi, then live.json
        code, out, err = self.run_main(*self.open_args(), FAKE_MODE="slow")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.registry()[0]["status"], "open")
        self.assertGreaterEqual(len(self.process_info_calls()), 7)

    def test_stored_cwd_missing_line_fails_at_once(self):
        code, out, err = self.run_main(*self.open_args(), FAKE_PANE_TEXT="Stored session working directory does not exist: /x\n")
        self.assertEqual(code, 2)
        self.assertIn("Pi printed its start-failure output", err)

    def test_process_gone_fails_at_once_with_the_pane_text(self):
        code, out, err = self.run_main(*self.open_args(), FAKE_MODE="exit", FAKE_PANE_TEXT="zsh: command not found: pi\n$ ")
        self.assertEqual(code, 2)
        self.assertIn("did not start: the Pi process is gone", err)
        self.assertIn("command not found: pi", err)
        self.assertEqual(self.registry()[0]["status"], "failed")

    def test_pi_start_failure_line_fails_at_once(self):
        code, out, err = self.run_main(*self.open_args(), FAKE_PANE_TEXT="Error: --fork cannot be combined with --continue\n")
        self.assertEqual(code, 2)
        self.assertIn("Pi printed its start-failure output", err)
        self.assertIn("Error: --fork cannot be combined", err)
        self.assertEqual(self.registry()[0]["status"], "failed")
        self.assertEqual(len(self.process_info_calls()), 1, "no waiting for the fallback")

    def test_nothing_after_the_wait_is_start_not_confirmed(self):
        code, out, err = self.run_main(*self.open_args(), PI_FOREMAN_START_CONFIRM_SECONDS="0.3", FAKE_PANE_TEXT="loading\n")
        self.assertEqual(code, 2)
        self.assertIn("start not confirmed", err)
        self.assertIn("loading", err)
        self.assertEqual(self.registry()[0]["status"], "open", "the pane stays registered")

    def test_plain_text_that_only_mentions_an_error_is_not_a_failure(self):
        code, out, err = self.run_main(*self.open_args(), PI_FOREMAN_START_CONFIRM_SECONDS="0.2", FAKE_PANE_TEXT="see Error: later\n")
        self.assertIn("start not confirmed", err)


if __name__ == "__main__":
    unittest.main()
