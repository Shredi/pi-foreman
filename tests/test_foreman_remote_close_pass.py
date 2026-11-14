"""The remote close finishes or says why not (scripts/foreman_session.py): the two outcomes of the send, the one deadline,
the pass that settles an expired close attempt in `prune` and `list`, `--force` on a child that is gone, the label parse
and the lists shared with remotewatch.ts. In-process, on the fake hc of tests/fakes/hc.py."""
from __future__ import annotations

import contextlib
import json
import os
import re
import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))
import test_foreman_remote_close_faults as ft  # noqa: E402

fsn, rt = ft.fsn, ft.rr.rt
ROOT = TESTS.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_radar as fr  # noqa: E402

HEX = "a" * 64
CLOSED = "4:closed:-:0"
WATCH_TS = (ROOT / "extensions" / "core-adapter" / "remotewatch.ts").read_text("utf-8")
CLOSE_TS = (ROOT / "extensions" / "core-adapter" / "close.ts").read_text("utf-8")


def old():
    return time.time() - 3600  # past any lifetime of an attempt


def iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ts)) + ".000Z"


class PassBase(ft.FaultBase):
    def hc_get_calls(self):
        return self.hc_calls("get")

    def registry_text(self):
        return (self.padir / "pi-foreman" / "state" / "sessions.json").read_text("utf-8")

    def wrap_run(self, fail_verbs=(), rm_code=None):
        """Run hc for real (the fake) but fail the given verbs: `kill` raises, `rm` exits non-zero."""
        real = subprocess.run

        def run(cmd, *a, **k):
            if len(cmd) > 1 and cmd[1] == "kill" and "kill" in fail_verbs:
                raise OSError("no kill")
            if len(cmd) > 1 and cmd[1] == "rm" and "rm" in fail_verbs:
                return subprocess.CompletedProcess(cmd, 1, stdout=b"", stderr=b"rm failed")
            return real(cmd, *a, **k)

        return mock.patch.object(fsn.subprocess, "run", side_effect=run)


class ExpiredAttemptTest(PassBase):
    def test_finished_terminal_closes_removes_and_ends_the_attach(self):
        for status in ("closing", "open", "pending"):
            with self.subTest(status):
                self.seed(status, closeTriedAt=old(), attach={"address": "t3"})
                self.set_terminal("alpha/t9", "finished")
                code, out, err = self.run_main("prune")
                self.assertEqual(code, 0, err)
                self.assertEqual(self.row()["status"], "closed")
                self.assertTrue(self.row()["reaped"])
                self.assertEqual(self.hc_calls("rm")[-1], ["rm", "alpha/t9"])
                self.assertEqual(self.hc_calls("kill")[-1], ["kill", "t3"])
                self.assertIn("reaped demo", out)

    def test_gone_terminal_closes_without_rm(self):
        self.seed("open", closeTriedAt=old())
        self.assertEqual(self.run_main("prune")[0], 0)
        self.assertEqual(self.row()["status"], "closed")
        self.assertEqual(self.hc_calls("rm"), [])

    def test_unreadable_terminal_is_unchanged_and_named(self):
        self.seed("closing", closeTriedAt=old())
        before = self.registry_text()
        code, out, err = self.run_main("prune", FAKE_HC_FAIL="1")
        self.assertEqual(code, 0, err)
        row = self.row()
        self.assertIsInstance(row.pop("passRetryAt"), float)  # the failed read is recorded: the list pass pauses the entry
        self.assertEqual(json.dumps({"version": 1, "sessions": [row]}), before)
        self.assertEqual(err.count("could not be removed"), 1)
        self.assertIn("demo", err)

    def test_live_without_the_closed_label_ends_nothing_and_clears_the_attempt(self):
        for label in (None, "3:refused:uncommitted-work", "3:result:%s:5" % HEX, "garbage", "5:closed:-:7", "3:refused:BAD SLUG"):
            for status in ("closing", "open"):
                for fg in ("bash", "pi"):
                    with self.subTest(label=label, status=status, fg=fg):
                        self.seed(status, closeTriedAt=old(), attach={"address": "t3"})
                        self.set_live(labels={"fm.notice": label} if label else {}, foreground=fg)
                        calls = len(self.hc_calls("kill", "rm"))
                        self.assertEqual(self.run_main("prune")[0], 0)
                        self.assertEqual(len(self.hc_calls("kill", "rm")), calls)
                        row = self.row()
                        self.assertEqual(row["status"], "open")
                        self.assertIsNone(row["closeTriedAt"])
                        self.assertNotIn("closedSeenAt", [k for k, v in row.items() if v is not None])
                        self.assertIsNotNone(row.get("closeExpiredAt"))  # an open entry gets the mark too (variant K)

    def test_expiry_line_and_mark_for_a_reopened_closing_or_an_open_entry_not_for_pending(self):
        self.seed("closing", closeTriedAt=old())
        self.set_live()
        code, out, err = self.run_main("prune")
        self.assertIn("close for demo@alpha expired without an answer", out)
        self.assertIn("close-remote --force demo", out)
        self.assertEqual(self.row()["lastError"], fsn.EXPIRED_NOTE)
        self.assertIsInstance(self.row()["closeExpiredAt"], float)
        for status in ("open", "pending"):
            self.seed(status, closeTriedAt=old(), lastError="a reason")
            code, out, err = self.run_main("prune")
            self.assertEqual("expired" in out, status == "open")  # variant K: an open entry gets the line and the mark
            self.assertEqual((self.row()["status"], self.row()["lastError"]), (status, "a reason"))
            self.assertEqual("closeExpiredAt" in self.row(), status == "open")

    def test_after_a_reopen_the_entry_is_not_read_again_until_a_new_attempt(self):
        self.seed("closing", closeTriedAt=old())
        self.set_live()
        self.run_main("prune")
        reads = len(self.hc_get_calls())
        self.run_main("prune")
        self.run_main("list")
        self.assertEqual(len(self.hc_get_calls()), reads)

    def test_not_yet_expired_and_no_tried_time_are_not_read(self):
        self.seed("closing", closeTriedAt=time.time() - fsn.CLOSE_ATTEMPT_LIFETIME + 60)
        self.set_live()
        self.run_main("list")
        self.seed("closing")
        self.run_main("list")
        self.assertEqual(self.hc_calls("get", "rm", "kill"), [])
        self.assertEqual(self.row()["status"], "closing")
        self.run_main("prune")  # the old reap of a closing entry reads it, but ends nothing
        self.assertEqual(self.hc_calls("rm", "kill"), [])
        self.assertEqual(self.row()["status"], "closing")

    def test_a_watcher_close_between_the_read_and_the_write_is_kept(self):
        self.seed("closing", closeTriedAt=old())
        real = fsn.hc_terminal_info

        def info(binary, address, timeout=fsn.HC_TIMEOUT):
            reply = real(binary, address, timeout)
            reg = fsn.read_registry(self.padir)
            reg["sessions"][0]["status"] = "closed"
            fsn.write_registry(self.padir, reg)
            return dict(reply, state="live", notice=None)

        with mock.patch.object(fsn, "hc_terminal_info", side_effect=info):
            self.assertEqual(self.run_main("prune")[0], 0)
        self.assertEqual(self.row()["status"], "closed")
        self.assertEqual(self.row()["closeTriedAt"] is None, False)
        self.assertNotIn("lastError", self.row())

    def test_age_does_not_depend_on_the_local_time_zone(self):
        if not hasattr(time, "tzset"):
            self.skipTest("no tzset")
        entry = {"closeTriedAt": time.time() - fsn.CLOSE_ATTEMPT_LIFETIME - 5}
        young = {"closeTriedAt": time.time() - fsn.CLOSE_ATTEMPT_LIFETIME + 60}
        old_tz = os.environ.get("TZ")
        self.addCleanup(lambda: (os.environ.__setitem__("TZ", old_tz) if old_tz else os.environ.pop("TZ", None), time.tzset()))
        for tz in ("Pacific/Kiritimati", "Pacific/Pago_Pago", "UTC"):
            os.environ["TZ"] = tz
            time.tzset()
            self.assertEqual((fsn.expired_attempt(entry, time.time()), fsn.expired_attempt(young, time.time())), (True, False), tz)

    def test_a_failed_machine_read_skips_its_other_entries_and_names_them(self):
        path = self.padir / "pi-foreman" / "state" / "sessions.json"
        self.seed("closing", closeTriedAt=old())
        reg = json.loads(path.read_text("utf-8"))
        reg["sessions"].append(dict(reg["sessions"][0], label="other", child="fm-other-abc123",
                                    hc={"address": "alpha/t8", "space": None, "tab": None}))
        path.write_text(json.dumps(reg), "utf-8")
        code, out, err = self.run_main("prune", FAKE_HC_FAIL="1")
        self.assertEqual(code, 0, err)
        self.assertEqual(err.count("could not be removed"), 1)
        self.assertIn("demo, other", err)
        self.assertEqual(len(self.hc_get_calls()), 1)
        self.assertEqual([s["status"] for s in self.parent_registry()], ["closing", "closing"])

    def test_the_pass_stays_within_its_total_limit_with_offline_machines(self):
        path = self.padir / "pi-foreman" / "state" / "sessions.json"
        rows = [{"label": "m%d" % i, "child": "fm-m%d-abc123" % i, "status": "closing", "machine": "m%d" % i,
                 "closeTriedAt": old(), "hc": {"address": "m%d/t1" % i}} for i in range(30)]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"version": 1, "sessions": rows}), "utf-8")
        clock = ft.Clock()

        def hang(cmd, **kw):
            clock.t += kw["timeout"]
            raise subprocess.TimeoutExpired(cmd, kw["timeout"])

        with mock.patch.object(fsn.time, "monotonic", clock.monotonic), mock.patch.object(fsn.time, "sleep", clock.sleep), \
                mock.patch.object(fsn.subprocess, "run", side_effect=hang):
            code, out, err = self.run_main("list")
        self.assertEqual(code, 0, err)
        self.assertLessEqual(clock.t - 1000.0, fsn.PASS_TOTAL_LIMIT + 1)
        self.assertEqual(err.count("could not be removed"), 1)
        self.assertIn("m29", err)


class ClosedLabelTest(PassBase):
    def test_a_live_terminal_reply_carries_the_labels_and_the_foreground(self):
        self.set_live(labels={"fm.notice": CLOSED}, foreground="bash")
        with contextlib.ExitStack() as stack:
            self.apply_env({}, stack)
            info = fsn.hc_terminal_info(fsn.hc_bin(), "alpha/t9")
        self.assertEqual(info, {"state": "live", "foreground": "bash", "notice": CLOSED})

    def test_a_first_sighting_ends_nothing(self):
        for status in ("closing", "open"):
            self.seed(status, closeTriedAt=old(), attach={"address": "t3"})
            self.set_live(labels={"fm.notice": CLOSED}, foreground="bash")
            self.assertEqual(self.run_main("prune")[0], 0)
            row = self.row()
            self.assertEqual((row["status"], row["closeTriedAt"] is None), (status, False))
            self.assertIsInstance(row["closedSeenAt"], float)
            self.assertEqual(self.hc_calls("kill", "rm"), [])

    def test_seen_on_an_earlier_run_a_shell_is_ended_and_the_entry_closed(self):
        self.seed("closing", closeTriedAt=old(), closedSeenAt=time.time() - 200, closedSeenSeq=4, attach={"address": "t3"})
        self.set_live(labels={"fm.notice": CLOSED}, foreground="Bash.EXE")
        code, out, err = self.run_main("prune")
        self.assertEqual(code, 0, err)
        row = self.row()
        self.assertEqual((row["status"], row["reaped"]), ("closed", True))
        self.assertIn("notice read from the terminal", row["note"])
        self.assertEqual((row["last"]["kind"], "path" in row["last"]), ("closed", False))
        self.assertIn(["kill", "alpha/t9"], self.hc_calls("kill"))
        self.assertIn(["kill", "t3"], self.hc_calls("kill"))
        self.assertEqual(self.hc_calls("rm"), [["rm", "alpha/t9"]])
        self.assertNotIn("alpha/t9", self.terminals())

    def test_seen_on_an_earlier_run_another_program_is_ended_too(self):
        self.seed("open", closeTriedAt=old(), closedSeenAt=time.time() - 200, closedSeenSeq=4, attach={"address": "t3"})
        self.set_live(labels={"fm.notice": CLOSED}, foreground="pi")
        self.assertEqual(self.run_main("prune")[0], 0)
        row = self.row()
        self.assertEqual(row["status"], "closed")
        self.assertTrue(row.get("reaped"))
        self.assertEqual(self.hc_calls("rm"), [["rm", "alpha/t9"]])
        self.assertIn(["kill", "alpha/t9"], self.hc_calls("kill"))
        self.assertNotIn("alpha/t9", self.terminals())

    def test_a_shell_that_cannot_be_ended_leaves_the_entry_for_the_next_run(self):
        self.seed("closing", closeTriedAt=old(), closedSeenAt=time.time() - 200, closedSeenSeq=4)
        self.set_live(labels={"fm.notice": CLOSED}, foreground="bash")
        before = self.registry_text()
        with self.wrap_run(fail_verbs=("kill",)):
            code, out, err = self.run_main("prune")
        self.assertEqual(code, 0, err)
        row = self.row()
        self.assertIsInstance(row.pop("passRetryAt"), float)  # the failed kill is recorded
        self.assertEqual(json.dumps({"version": 1, "sessions": [row]}), before)
        self.assertIn("demo", err)

    def test_a_terminal_that_cannot_be_removed_is_retried_and_then_closed_by_its_finish(self):
        self.seed("closing", closeTriedAt=old(), closedSeenAt=time.time() - 200, closedSeenSeq=4)
        self.set_live(labels={"fm.notice": CLOSED}, foreground="zsh")
        with self.wrap_run(fail_verbs=("rm",)), mock.patch.object(fsn.time, "sleep"):
            self.assertEqual(self.run_main("prune")[0], 0)
        self.assertEqual(self.row()["status"], "closing")
        self.assertEqual(self.terminals()["alpha/t9"]["state"], "finished")
        self.assertEqual(self.run_main("prune")[0], 0)
        self.assertEqual(self.row()["status"], "closed")
        self.assertNotIn("alpha/t9", self.terminals())

    def test_the_label_and_the_address_never_reach_a_command_line_beyond_the_recorded_address(self):
        value = "4:closed:-:0"
        self.seed("closing", closeTriedAt=old(), closedSeenAt=time.time() - 200, closedSeenSeq=4)
        self.set_live(labels={"fm.notice": value}, foreground="sh")
        self.set_live(address="alpha/t8", labels={"fm.notice": "9:closed:-:0"}, foreground="sh")
        self.assertEqual(self.run_main("prune")[0], 0)
        for argv in lines_of_hc(self):
            self.assertNotIn(value, " ".join(argv))
            self.assertNotIn("alpha/t8", " ".join(argv))
        self.assertIn("alpha/t8", self.terminals())

    def test_the_helper_ends_a_shell_after_an_old_closed_notice_only(self):
        now = time.time()
        for age, want in ((fsn.WATCHER_REAP_WAIT + 5, True), (fsn.WATCHER_REAP_WAIT - 5, False)):
            entry = {"last": {"kind": "closed", "at": iso(now - age)}, "noticeSeq": 4}
            self.assertEqual(fsn.shell_may_end(entry, now, 4), want, age)
        self.assertFalse(fsn.shell_may_end({"last": {"kind": "result", "at": iso(now - 3600)}, "noticeSeq": 4}, now, 4))
        self.assertFalse(fsn.shell_may_end({}, now, 4))
        self.assertFalse(fsn.shell_may_end({"closedSeenAt": now - 1, "closedSeenSeq": 4}, now, 4))  # younger than the wait

    def test_the_watcher_wait_equals_the_typescript_one(self):
        polls = int(re.search(r"export const REAP_POLLS = (\d+);", WATCH_TS).group(1))
        ms = int(re.search(r"export const REAP_POLL_MS = ([\d_]+);", WATCH_TS).group(1).replace("_", ""))
        self.assertEqual(fsn.WATCHER_REAP_WAIT * 1000, polls * ms)


def lines_of_hc(case):
    return [json.loads(l) for l in case.logs["hc"].read_text("utf-8").splitlines()]


class SharedWithTypeScriptTest(unittest.TestCase):
    def test_the_attempt_lifetime_is_the_close_order_lifetime_plus_the_margin(self):
        ms = eval(re.search(r"export const CLOSE_ORDER_MAX_AGE_MS = ([\d_ *]+);", CLOSE_TS).group(1).replace("_", ""))
        self.assertEqual(fsn.CLOSE_ORDER_LIFETIME * 1000, ms)
        self.assertEqual(fsn.CLOSE_ATTEMPT_LIFETIME, fsn.CLOSE_ORDER_LIFETIME + 5 * 60)

    def test_the_shell_name_lists_are_equal(self):
        names = re.search(r"const SHELL_NAMES = new Set\(\[([^\]]*)\]\)", WATCH_TS).group(1)
        self.assertEqual(set(re.findall(r'"([^"]+)"', names)), fsn.SHELL_NAMES)
        for name, want in (("bash", True), ("Bash.EXE", True), ("C:\\Windows\\System32\\cmd.exe", True), ("/bin/zsh", True),
                           (" pwsh ", True), ("pi", False), ("node.exe", False), ("", False), (None, False), (5, False)):
            self.assertEqual(fsn.is_shell_name(name), want, name)

    def ts_regex(self, name):
        source = re.search(r"const %s = /(.*)/;" % name, WATCH_TS).group(1)
        self.assertTrue(source.startswith("^") and source.endswith("$"), source)
        return re.compile(source.replace("\\d", "[0-9]")[:-1] + r"\Z")

    def test_the_python_label_parse_and_notice_re_agree_on_one_table(self):
        notice, refused = self.ts_regex("NOTICE_RE"), self.ts_regex("REFUSED_RE")
        table = [("1:closed:-:0", "closed"), ("1:closed:-:00", "closed"), ("5:closed:-:7", None), ("5:result:-:0", None),
                 ("1:result:%s:5" % HEX, "result"), ("1:closed:%s:5" % HEX, "closed"), ("2:plan:%s:1" % HEX, "plan"),
                 ("2:update:%s:1" % HEX, "update"), ("2:ask:%s:1" % HEX, "ask"), ("3:refused:uncommitted-work", "refused"),
                 ("3:refused:BAD", None), ("3:refused:" + "a" * 41, None), ("3:refused:", None), ("x:closed:-:0", None),
                 ("1:closed:-:0\n", None), ("1:other:-:0", None), ("", None), ("1:result:%s:5" % HEX.upper(), None),
                 ("1:result:%s:5" % HEX[:-1], None), ("\uff11:closed:-:0", None), ("1:closed:-:\uff10", None),
                 ("1:refused:ok\n", None), (None, None), (5, None)]
        for value, kind in table:
            self.assertEqual(fsn.notice_kind(value), kind, repr(value))
            if isinstance(value, str):
                self.assertEqual(bool(fsn.NOTICE_LABEL_RE.match(value)), bool(notice.match(value)), repr(value))
                self.assertEqual(bool(fsn.REFUSED_LABEL_RE.match(value)), bool(refused.match(value)), repr(value))


class SendOutcomesTest(PassBase):
    def close(self, *args, **env):
        return self.run_main("close-remote", "demo", *args, **env)

    def opened_with_attach(self):
        self.assertEqual(self.run_main(*self.open_args(), HC_TERMINAL_ID="t0")[0], 0)

    def test_confirmed_is_closing_with_a_tried_time_and_ends_nothing_locally(self):
        self.opened_with_attach()
        before = time.time()
        code, out, err = self.close()
        self.assertEqual((code, json.loads(out)), (0, {"woke": True, "ok": True}), err)
        row = self.row()
        self.assertEqual((row["status"], row["lastError"], row["closeExpiredAt"]), ("closing", None, None))
        self.assertGreaterEqual(row["closeTriedAt"], before - 1)
        self.assertEqual(self.hc_calls("kill"), [])

    def test_woke_false_is_not_sent_and_open_with_a_tried_time(self):
        self.opened_with_attach()
        code, out, err = self.close(FAKE_NODE_EXIT="1")
        self.assertEqual((code, out), (1, ""))
        self.assertIn("close for demo@alpha not sent (the remote could not wake the child)", err)
        self.assertIn("; if the child is gone: foreman session close-remote --force demo", err)
        row = self.row()
        self.assertEqual(row["status"], "open")
        self.assertIsInstance(row["closeTriedAt"], float)
        self.assertEqual(row["lastError"], "the remote could not wake the child")
        self.assertEqual(self.hc_calls("get", "rm", "kill"), [])

    def test_a_failed_remote_call_is_open_with_a_tried_time_in_each_of_its_three_ways(self):
        for mode in ("timed_out", "spawn_failed", "garbage"):
            with self.subTest(mode):
                self.seed("open", label="demo")
                code, out, err = self.close(FAKE_HC_EXEC_MODE=mode)
                self.assertEqual((code, out), (1, ""))
                self.assertEqual(self.row()["status"], "open")
                self.assertIsInstance(self.row()["closeTriedAt"], float)
                self.assertIn("not sent", err)

    def test_a_refusal_before_an_order_exists_has_no_tried_time_and_no_hint(self):
        self.assertEqual(self.run_main(*self.open_args())[0], 0)
        code, out, err = self.close(FAKE_HC_MACHINES=json.dumps(["beta"]))
        self.assertEqual(code, 1)
        self.assertNotIn("closeTriedAt", self.row())
        self.assertNotIn("--force", err)

    def test_a_refusal_by_the_remote_with_a_code_has_no_tried_time_and_no_hint(self):
        self.assertEqual(self.run_main(*self.open_args())[0], 0)
        reg = fsn.read_registry(self.padir)
        reg["sessions"][0]["parentAddress"] = rt.OTHER + "@beta"
        fsn.write_registry(self.padir, reg)
        code, out, err = self.close()
        self.assertEqual(code, 1)
        self.assertIn("[wrong_session]", err)
        self.assertNotIn("closeTriedAt", self.row())
        self.assertNotIn("--force", err)

    def test_a_refused_or_failed_close_removes_nothing_on_either_machine(self):
        self.opened_with_attach()
        before = {k: v for k, v in self.row().items() if k not in ("lastError", "closeTriedAt", "closeExpiredAt")}
        terminals = self.terminals_path().read_text("utf-8")
        mirror = self.row().get("mirror")
        listing = sorted(p.name for p in Path(mirror).iterdir()) if mirror and Path(mirror).is_dir() else None
        for env in ({"FAKE_NODE_EXIT": "1"}, {"FAKE_HC_EXEC_MODE": "timed_out"}):
            self.close(**env)
        after = {k: v for k, v in self.row().items() if k not in ("lastError", "closeTriedAt", "closeExpiredAt")}
        self.assertEqual(after, before)
        self.assertEqual(self.terminals_path().read_text("utf-8"), terminals)
        self.assertEqual(self.hc_calls("kill", "rm"), [])
        if listing is not None:
            self.assertEqual(sorted(p.name for p in Path(mirror).iterdir()), listing)

    def test_pending_gets_no_hint_and_keeps_its_status(self):
        self.assertEqual(self.run_main(*self.open_args())[0], 0)
        reg = fsn.read_registry(self.padir)
        reg["sessions"][0]["status"] = "pending"
        fsn.write_registry(self.padir, reg)
        code, out, err = self.close(FAKE_NODE_EXIT="1")
        self.assertEqual(code, 1)
        self.assertNotIn("--force", err)
        self.assertEqual(self.row()["status"], "pending")
        self.assertIsInstance(self.row()["closeTriedAt"], float)

    def test_a_new_attempt_clears_the_expiry_mark(self):
        self.seed("open", closeExpiredAt=old())
        self.close(FAKE_HC_EXEC_MODE="timed_out")
        self.assertIsNone(self.row()["closeExpiredAt"])

    def test_the_remote_send_limit_is_below_the_call_timeout(self):
        self.assertLess(fsn.CLOSE_SEND_TIMEOUT, fsn.CLOSE_TIMEOUT)
        self.assertLess(fsn.CLOSE_DEADLINE, 120)


class ForceOnAGoneChildTest(PassBase):
    def force(self):
        return self.run_main("close-remote", "demo", "--force")

    def assert_forced(self):
        code, out, err = self.force()
        self.assertEqual(code, 0, err)
        self.assertEqual(self.row()["status"], "closed")
        self.assertEqual(self.row()["note"], "closed by --force")
        self.assertIn(["kill", "alpha/t9"], self.hc_calls("kill"))
        self.assertEqual(self.hc_calls("rm"), [["rm", "alpha/t9"]])

    def test_accepted_with_a_tried_time_and_no_notice_since(self):
        self.seed("open", closeTriedAt=time.time() - 30)
        self.set_live()
        self.assert_forced()

    def test_accepted_with_the_expiry_mark_and_no_notice_since(self):
        self.seed("open", closeExpiredAt=time.time() - 30, last={"kind": "result", "path": "r", "at": iso(time.time() - 600)})
        self.set_live()
        self.assert_forced()

    def test_refused_for_a_fresh_open_entry(self):
        self.seed("open")
        self.set_live()
        code, out, err = self.force()
        self.assertEqual(code, 1)
        self.assertIn("[not_open]", err)
        self.assertIn("try a normal close first", err)
        self.assertEqual(self.hc_calls("kill", "rm", "get"), [])
        self.assertEqual(self.row()["status"], "open")

    def test_refused_after_a_notice_of_each_kind_since_the_attempt(self):
        for kind in ("refused", "result", "update"):
            with self.subTest(kind):
                self.seed("open", closeTriedAt=time.time() - 300, last={"kind": kind, "path": "x", "at": iso(time.time() - 60)})
                self.set_live()
                code, out, err = self.force()
                self.assertEqual(code, 1)
                self.assertIn("[not_open]", err)
                self.assertEqual(self.row()["status"], "open")
        self.assertEqual(self.hc_calls("kill", "rm"), [])

    def test_accepted_when_the_last_notice_is_older_than_the_attempt(self):
        self.seed("open", closeTriedAt=time.time() - 30, last={"kind": "result", "path": "x", "at": iso(time.time() - 600)})
        self.set_live()
        self.assert_forced()

    def test_refused_when_the_tried_time_was_cleared_by_a_later_notice_or_reopen(self):
        self.seed("open", closeTriedAt=None, last={"kind": "result", "path": "x", "at": iso(time.time() - 600)})
        self.set_live()
        code, out, err = self.force()
        self.assertEqual((code, self.row()["status"]), (1, "open"))
        self.assertIn("[not_open]", err)

    def test_the_expiry_pass_of_an_open_entry_sets_no_mark_and_a_closing_one_does(self):
        self.seed("open", closeTriedAt=old())
        self.set_live()
        self.run_main("prune")
        self.assertIsNotNone(self.row()["closeExpiredAt"])  # variant K: the open entry gets the mark, so --force works
        self.assertIsNone(self.row()["closeTriedAt"])
        code, out, err = self.force()
        self.assertEqual((code, self.row()["status"]), (0, "closed"))

    def test_a_reopened_entry_can_be_forced_and_the_hint_is_in_its_expiry_line(self):
        self.seed("closing", closeTriedAt=old())
        self.set_live()
        code, out, err = self.run_main("prune")
        self.assertIn("close-remote --force demo", out)
        self.assert_forced()

    def test_force_on_a_pending_entry_is_a_normal_close(self):
        self.assertEqual(self.run_main(*self.open_args())[0], 0)
        reg = fsn.read_registry(self.padir)
        reg["sessions"][0]["status"] = "pending"
        fsn.write_registry(self.padir, reg)
        code, out, err = self.force()
        self.assertEqual(code, 0, err)
        self.assertEqual(self.row()["status"], "closing")


class ScriptedHcTest(PassBase):
    """A fake clock and a scripted hc: each verb takes `took` seconds, or hangs for the limit it was given."""

    def run_scripted(self, *argv, hang=(), took=None):
        clock, seen = ft.Clock(), []
        took = took or {}

        def fake_run(cmd, **kw):
            verb = cmd[1]
            seen.append((list(cmd), kw.get("timeout")))
            if verb in hang:
                clock.t += kw["timeout"]
                raise subprocess.TimeoutExpired(cmd, kw["timeout"])
            clock.t += took.get(verb, 0.1)
            if verb == "machine":
                return ft.completed(cmd, b'{"machines":[{"name":"alpha"}]}')
            if verb == "get":
                return ft.completed(cmd, b'{"state":"live","labels":{},"foreground":{"name":"pi"}}')
            return ft.completed(cmd, ft.exec_reply() if verb == "exec" else b"{}")

        with mock.patch.object(fsn.time, "monotonic", clock.monotonic), mock.patch.object(fsn.time, "sleep", clock.sleep), \
                mock.patch.object(fsn.subprocess, "run", side_effect=fake_run):
            code, out, err = self.run_main(*argv)
        return code, err, clock.t - 1000.0, seen

    def test_time_in_hand_keeps_todays_limits(self):
        self.seed("open")
        code, err, elapsed, seen = self.run_scripted("close-remote", "demo")
        (exec_call,) = [c for c in seen if c[0][1] == "exec"]
        self.assertEqual((exec_call[0][exec_call[0].index("--timeout") + 1], exec_call[1]), ("20", 30))
        self.assertEqual(len([c for c in seen if c[0][1] == "get"]), fsn.REAP_POLLS + 1)

    def test_a_hanging_machine_listing_ends_inside_the_limit_with_nothing_started(self):
        self.seed("open")
        code, err, elapsed, seen = self.run_scripted("close-remote", "demo", hang=("machine",))
        self.assertEqual(code, 1)
        self.assertLess(elapsed, fsn.CLOSE_DEADLINE)
        self.assertNotIn("closeTriedAt", self.row())

    def test_a_hanging_order_ends_inside_the_limit_and_sets_the_tried_time(self):
        self.seed("open", attach={"address": "t3"})
        code, err, elapsed, seen = self.run_scripted("close-remote", "demo", hang=("exec",))
        self.assertEqual(code, 1)
        self.assertLess(elapsed, fsn.CLOSE_DEADLINE)
        self.assertEqual(self.row()["status"], "open")
        self.assertIsInstance(self.row()["closeTriedAt"], float)

    def test_a_slow_listing_shrinks_the_order_to_what_is_left(self):
        self.seed("open")
        code, err, elapsed, seen = self.run_scripted("close-remote", "demo", took={"machine": 80}, hang=("exec",))
        (exec_call,) = [c for c in seen if c[0][1] == "exec"]
        self.assertLessEqual(exec_call[1], fsn.CLOSE_DEADLINE - 80 + 0.01)
        self.assertLess(elapsed, fsn.CLOSE_DEADLINE + 1)

    def test_hanging_reap_calls_end_inside_the_limit_and_the_entry_stays_closing(self):
        self.seed("open", attach={"address": "t3"})
        code, err, elapsed, seen = self.run_scripted("close-remote", "demo", hang=("get", "rm", "kill"))
        self.assertEqual(code, 0, err)
        self.assertLess(elapsed, fsn.CLOSE_DEADLINE + 1)
        self.assertEqual(self.row()["status"], "closing")
        self.assertIn("remote terminal still running; prune will remove it", err)
        self.assertEqual([c for c in seen if c[0][1] == "kill"], [])

    def test_no_time_left_for_the_reap_prints_the_skip_line(self):
        self.seed("open")
        code, err, elapsed, seen = self.run_scripted("close-remote", "demo", took={"exec": fsn.CLOSE_DEADLINE - 0.5})
        self.assertEqual(code, 0, err)
        self.assertIn("remote terminal still running; prune will remove it", err)
        self.assertEqual([c for c in seen if c[0][1] == "get"], [])
        self.assertEqual(self.row()["status"], "closing")

    def test_a_force_close_whose_calls_hang_ends_closed_with_the_warning_inside_the_limit(self):
        self.seed("closing", attach={"address": "t3"})
        code, err, elapsed, seen = self.run_scripted("close-remote", "demo", "--force", hang=("get", "kill", "rm"))
        self.assertEqual(code, 0, err)
        self.assertLessEqual(elapsed, fsn.CLOSE_DEADLINE)
        self.assertEqual((self.row()["status"], self.row()["reaped"]), ("closed", True))
        self.assertIn("the remote terminal may still exist", err)
        self.assertIn("marked closed anyway", err)
        attach_kill = [c for c in seen if c[0][1] == "kill" and c[0][2] == "t3"]
        self.assertEqual(len(attach_kill), 1)
        self.assertLessEqual(attach_kill[0][1], fsn.FORCE_ATTACH_SLICE)

    def test_an_open_entry_forced_while_hanging_ends_inside_the_limit(self):
        self.seed("open", closeTriedAt=time.time() - 30)
        code, err, elapsed, seen = self.run_scripted("close-remote", "demo", "--force", hang=("get", "kill", "rm"))
        self.assertEqual((code, self.row()["status"]), (0, "closed"))
        self.assertLessEqual(elapsed, fsn.CLOSE_DEADLINE)


class ListTest(PassBase):
    def test_list_with_nothing_expired_makes_no_call_and_no_write(self):
        self.seed("closing", closeTriedAt=time.time() - 60)
        before = self.registry_text()
        for args in (("list",), ("list", "--json")):
            self.assertEqual(self.run_main(*args)[0], 0)
        self.assertEqual(self.hc_calls("get", "rm", "kill", "exec"), [])
        self.assertEqual(self.registry_text(), before)

    def test_list_json_with_an_expired_entry_stays_one_json_document(self):
        self.seed("closing", closeTriedAt=old(), attach={"address": "t3"})
        self.set_terminal("alpha/t9", "finished")
        code, out, err = self.run_main("list", "--json")
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["sessions"][0]["status"], "closed")
        self.assertIn("reaped demo", err)
        self.assertNotIn("reaped demo", out)

    def test_list_json_with_a_reopened_entry_puts_the_expiry_line_on_stderr(self):
        self.seed("closing", closeTriedAt=old())
        self.set_live()
        code, out, err = self.run_main("list", "--json")
        self.assertEqual(json.loads(out)["sessions"][0]["status"], "open")
        self.assertIn("expired without an answer", err)

    def test_list_text_prints_the_settled_row_and_no_pass_line(self):
        self.seed("closing", closeTriedAt=old())
        self.set_terminal("alpha/t9", "finished")
        code, out, err = self.run_main("list")
        self.assertIn("closed", out)
        self.assertNotIn("reaped", out)

    def test_list_names_an_unreadable_entry_on_stderr(self):
        self.seed("closing", closeTriedAt=old())
        code, out, err = self.run_main("list", "--json", FAKE_HC_FAIL="1")
        self.assertEqual(json.loads(out)["sessions"][0]["status"], "closing")
        self.assertIn("demo", err)


class RadarTest(unittest.TestCase):
    def test_an_expired_closing_entry_is_drawn_from_stored_state_with_no_remote_call(self):
        base = {"label": "demo", "status": "closing", "machine": "alpha", "closeTriedAt": old()}
        now = time.time()
        with mock.patch.object(fsn.subprocess, "run", side_effect=AssertionError("a remote call")):
            self.assertEqual(fr.remote_glyph(dict(base, remoteLive={"state": "lost"}), now - 7200, now), ("idle", "finished"))
            self.assertEqual(fr.remote_glyph(dict(base, remoteLive={"state": "idle"}), now - 7200, now), ("idle", "idle"))
            self.assertEqual(fr.remote_glyph(base, now - 7200, now), ("idle", "closing"))


class LockTest(rt.NoticeBase):
    def deny(self, times):
        real, left = fsn.os.open, [times]

        def deny(path, *a, **k):
            if str(path).endswith("notice-seq.lock") and left[0] != 0:
                left[0] -= 1
                raise PermissionError(13, "denied")
            return real(path, *a, **k)

        return mock.patch.object(fsn.os, "open", side_effect=deny)

    def test_a_permission_error_once_is_busy_and_the_next_try_succeeds(self):
        with self.deny(1), mock.patch.object(fsn.time, "sleep") as sleep:
            self.assertEqual(fsn.next_notice_seq(self.dir), 1)
        self.assertEqual(sleep.call_count, 1)

    def test_a_permission_error_always_ends_in_the_timeout_error_as_a_json_line(self):
        with self.deny(-1), mock.patch.object(fsn.time, "sleep"):
            with self.assertRaises(fsn.NoticeFailed) as caught:
                fsn.next_notice_seq(self.dir)
            self.assertEqual(caught.exception.reply, {"error": "label_failed", "detail": "seq_lock_timeout"})
            (self.dir / "result.md").write_text("# r\n", "utf-8")
            code, out, err = self.run_main("remote", "notice", "result")
        self.assertEqual(code, 1, err)
        reply = json.loads(out.strip().splitlines()[-1])
        self.assertEqual((reply["ok"], reply["error"], reply["detail"]), (False, "label_failed", "seq_lock_timeout"))


if __name__ == "__main__":
    unittest.main()
