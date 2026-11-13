"""Static faults of the remote close, each reproduced by a test that failed on main before the fix: an undelivered close was
`closing`, `closing` never ended, a refused close stayed `closing`, `close-remote` ended the attach terminal, the close ran
past the caller's 120 s, the remote send outlived the call, and a `PermissionError` on the notice lock left a traceback."""
from __future__ import annotations

import base64
import json
import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))
import test_foreman_remote_reap as rr  # noqa: E402

fsn = rr.fsn
OLD = time.time() - 3600  # an hour: past any lifetime of an attempt


class FaultBase(rr.ReapBase):
    def set_live(self, address="alpha/t9", labels=None, foreground="pi"):
        t = self.terminals()
        t[address] = {"address": address, "state": "live", "labels": labels or {}, "foreground": {"name": foreground}}
        self.terminals_path().parent.mkdir(parents=True, exist_ok=True)
        self.terminals_path().write_text(json.dumps(t), "utf-8")


class UndeliveredCloseTest(FaultBase):
    def test_l5a_a_close_the_child_was_not_woken_for_is_not_closing(self):
        self.assertEqual(self.run_main(*self.open_args())[0], 0)
        code, out, err = self.run_main("close-remote", "demo", FAKE_NODE_EXIT="1")
        self.assertEqual((code, out), (1, ""), err)
        self.assertEqual(self.row()["status"], "open")
        self.assertIn("not sent", err)


class ExpiryTest(FaultBase):
    def test_l5b_closing_ends_by_itself_after_its_lifetime(self):
        self.seed("closing", closeTriedAt=OLD)
        self.set_live()
        self.assertEqual(self.run_main("prune")[0], 0)
        self.assertEqual(self.row()["status"], "open")
        self.assertEqual(self.row()["lastError"], "close order expired without an answer")

    def test_l1r_a_refused_close_does_not_stay_closing_without_the_watcher(self):
        self.seed("closing", closeTriedAt=OLD)
        self.set_live(labels={"fm.notice": "3:refused:uncommitted-work"})
        self.assertEqual(self.run_main("prune")[0], 0)
        self.assertEqual(self.row()["status"], "open")
        self.assertEqual(self.hc_calls("kill", "rm"), [])


class AttachTest(FaultBase):
    def test_l1a_close_remote_leaves_the_attach_terminal_to_the_close_that_finishes(self):
        self.run_main(*self.open_args(), HC_TERMINAL_ID="t0")
        code, out, err = self.run_main("close-remote", "demo")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.hc_calls("kill"), [])

    def test_l1a_a_refused_close_removes_nothing_locally(self):
        self.run_main(*self.open_args(), HC_TERMINAL_ID="t0")
        code, out, err = self.run_main("close-remote", "demo", FAKE_NODE_EXIT="1")
        self.assertEqual(code, 1, err)
        self.assertEqual(self.hc_calls("kill", "rm"), [])


class Clock:
    def __init__(self):
        self.t = 1000.0

    def monotonic(self):
        return self.t

    def sleep(self, seconds):
        self.t += seconds


def completed(cmd, stdout=b"", code=0):
    return subprocess.CompletedProcess(cmd, code, stdout=stdout, stderr=b"")


def exec_reply(woke=True):
    body = json.dumps({"ok": True, "woke": woke}) + "\n"
    env = {"code": 0, "ms": 1, "signal": None, "stderr": "", "timed_out": False, "truncated": False,
           "stdout": base64.b64encode(body.encode()).decode()}
    return json.dumps(env).encode()


class DeadlineTest(FaultBase):
    """A fake clock: a hanging hc call advances it by the call's own limit. The caller (session.ts) gives up at 120 s."""

    def run_hanging(self, hang_from, *argv):
        clock = Clock()

        def fake_run(cmd, **kw):
            verb = cmd[1]
            order = ["machine", "exec", "get", "kill", "rm"]
            if order.index(verb) >= order.index(hang_from):
                clock.t += kw["timeout"]
                raise subprocess.TimeoutExpired(cmd, kw["timeout"])
            clock.t += 0.1
            if verb == "machine":
                return completed(cmd, b'{"machines":[{"name":"alpha"}]}')
            return completed(cmd, exec_reply())

        with mock.patch.object(fsn.time, "monotonic", clock.monotonic), mock.patch.object(fsn.time, "sleep", clock.sleep), \
                mock.patch.object(fsn.subprocess, "run", side_effect=fake_run):
            code, out, err = self.run_main(*argv)
        return code, err, clock.t - 1000.0

    def test_l10_a_close_whose_every_call_after_the_order_hangs_stays_below_the_callers_limit(self):
        self.seed("open", attach={"address": "t3"})
        code, err, elapsed = self.run_hanging("get", "close-remote", "demo")
        self.assertLess(elapsed, 120)

    def test_l10_a_force_close_whose_every_call_hangs_stays_below_the_callers_limit(self):
        self.seed("closing", attach={"address": "t3"})
        code, err, elapsed = self.run_hanging("get", "close-remote", "demo", "--force")
        self.assertLess(elapsed, 120)


class SendLimitTest(FaultBase):
    def test_l10b_the_remote_send_ends_before_the_call_that_carries_it(self):
        (self.radir / "pi-foreman").mkdir(parents=True, exist_ok=True)
        seen = []

        def send(to, text, *rest, **kw):
            seen.append((rest, kw))
            return True, ""

        entry, rh = self.opened()
        params = {"handoffName": entry["handoffName"], "parentAddress": rr.rt.ADDRESS}
        with mock.patch.object(fsn, "send_intercom", side_effect=send):
            code, reply = self.remote("close", params)
        self.assertEqual(code, 0, reply)
        timeouts = [kw.get("timeout", rest[0] if rest else fsn.HERDR_TIMEOUT) for rest, kw in seen]
        self.assertEqual(len(timeouts), 1)
        self.assertLess(timeouts[0], fsn.CLOSE_TIMEOUT)


class NoticeLockTest(rr.rt.NoticeBase):
    def test_s7_a_permission_error_on_the_lock_ends_as_a_json_line(self):
        real = fsn.os.open

        def deny(path, *a, **k):
            if str(path).endswith("notice-seq.lock"):
                raise PermissionError(13, "denied")
            return real(path, *a, **k)

        (self.dir / "result.md").write_text("# r\n", "utf-8")
        with mock.patch.object(fsn.os, "open", side_effect=deny), mock.patch.object(fsn.time, "sleep"):
            code, out, err = self.run_main("remote", "notice", "result")
        self.assertEqual(code, 1, err)
        self.assertEqual(json.loads(out.strip().splitlines()[-1])["error"], "label_failed")


if __name__ == "__main__":
    unittest.main()
