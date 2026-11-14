"""The second part of the remote close (scripts/foreman_session.py): the minimum gap before a shell is ended, damaged time
fields, an address that lies on another machine, `--force` after an expired attempt, leftover terminals of `closed`
entries with the retry pause, and the address `<label>@<machine>`. In-process, on the fake hc of tests/fakes/hc.py."""
from __future__ import annotations

import contextlib
import json
import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))
import test_foreman_remote_close_pass as cp  # noqa: E402

fsn, ft = cp.fsn, cp.ft
CLOSED = "4:closed:-:0"
WAIT = fsn.WATCHER_REAP_WAIT
CASES = json.loads((TESTS / "fixtures" / "remote-address-cases.json").read_text("utf-8"))
BAD_TIMES = [("huge", 1e300), ("inf", float("inf")), ("nan", float("nan")), ("bigint", 10 ** 400), ("negative", -5),
             ("string", "x"), ("bool", True)]


class HBase(cp.PassBase):
    def reset_hc(self):
        for p in (self.logs["hc"], self.terminals_path()):
            if p.exists():
                p.unlink()

    def seed(self, *args, **kw):
        self.reset_hc()
        super().seed(*args, **kw)

    def open_real(self, **fields):
        """A real open on the fake remote (the entry's terminal is alpha/t1, which the fake knows as `t1`: gone until a test puts
        it), then `fields` written to the entry."""
        self.reset_hc()
        (self.padir / "pi-foreman" / "state" / "sessions.json").unlink(missing_ok=True)
        self.assertEqual(self.run_main(*self.open_args())[0], 0)
        if fields:
            reg = fsn.read_registry(self.padir)
            reg["sessions"][0].update(fields)
            fsn.write_registry(self.padir, reg)

    def put(self, address, state, labels=None, foreground="pi"):
        t = self.terminals()
        t[address] = {"address": address, "state": state, "labels": labels or {}, "foreground": {"name": foreground}}
        self.terminals_path().parent.mkdir(parents=True, exist_ok=True)
        self.terminals_path().write_text(json.dumps(t), "utf-8")

    def rows(self, *specs):
        """Write the registry: one machine entry per spec (label, status, address, extra fields)."""
        out = []
        self.reset_hc()
        for label, status, address, extra in specs:
            entry = {"label": label, "child": "fm-%s-abc123" % label, "status": status, "machine": "alpha",
                     "hc": {"address": address, "space": None, "tab": None}, "handoff": "/h/" + label}
            entry.update(extra)
            out.append(entry)
        path = self.padir / "pi-foreman" / "state" / "sessions.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"version": 1, "sessions": out}), "utf-8")

    def row_of(self, label):
        return [s for s in self.parent_registry() if s["label"] == label][0]

    def no_remote_calls(self):
        self.assertEqual(self.hc_calls("get", "rm", "kill", "exec"), [])


class MinimumGapTest(HBase):
    def attempt(self, **extra):
        self.seed("closing", closeTriedAt=cp.old(), **extra)
        self.put("alpha/t9", "live", {"fm.notice": CLOSED}, "bash")

    def test_a_sighting_younger_than_the_wait_ends_nothing(self):
        for age in (1, WAIT - 1):
            with self.subTest(age=age):
                seen = time.time() - age
                self.attempt(closedSeenAt=seen, closedSeenSeq=4)
                before = self.row()["closeTriedAt"]
                self.assertEqual(self.run_main("prune")[0], 0)
                self.assertEqual(self.hc_calls("kill", "rm"), [])
                row = self.row()
                self.assertEqual((row["status"], row["closeTriedAt"], row["closedSeenAt"]), ("closing", before, seen))

    def test_at_the_wait_a_shell_is_ended_and_the_label_number_is_recorded(self):
        self.attempt(closedSeenAt=time.time() - WAIT - 1, closedSeenSeq=4)
        self.assertEqual(self.run_main("prune")[0], 0)
        row = self.row()
        self.assertEqual((row["status"], row["reaped"], row["noticeSeq"]), ("closed", True, 4))
        self.assertEqual(self.hc_calls("rm"), [["rm", "alpha/t9"]])

    def test_a_closed_last_notice_older_than_the_wait_ends_without_a_sighting(self):
        self.attempt(last={"kind": "closed", "at": cp.iso(time.time() - WAIT - 30)}, noticeSeq=4)
        self.assertEqual(self.run_main("prune")[0], 0)
        self.assertEqual((self.row()["status"], self.row()["reaped"]), ("closed", True))
        self.assertEqual(self.hc_calls("rm"), [["rm", "alpha/t9"]])

    def test_a_closed_last_notice_with_another_number_is_no_proof(self):
        self.attempt(last={"kind": "closed", "at": cp.iso(time.time() - WAIT - 30)}, noticeSeq=9)
        self.assertEqual(self.run_main("prune")[0], 0)
        self.assertEqual(self.hc_calls("kill", "rm"), [])
        self.assertEqual(self.row()["status"], "closing")

    def test_a_sighting_in_the_future_is_rewritten_and_ends_nothing(self):
        self.attempt(closedSeenAt=time.time() + 5000, closedSeenSeq=4)
        self.assertEqual(self.run_main("prune")[0], 0)
        self.assertEqual(self.hc_calls("kill", "rm"), [])
        self.assertLessEqual(self.row()["closedSeenAt"], time.time())

    def test_a_sighting_without_a_number_or_with_another_is_a_first_sighting_and_one_wait_later_it_ends(self):
        for extra in ({}, {"closedSeenSeq": 3}, {"closedSeenSeq": True}, {"closedSeenSeq": "4"}):
            with self.subTest(extra=extra):
                self.attempt(closedSeenAt=time.time() - WAIT - 500, **extra)
                self.assertEqual(self.run_main("prune")[0], 0)
                self.assertEqual(self.hc_calls("kill", "rm"), [])
                row = self.row()
                self.assertEqual((row["status"], row["closedSeenSeq"]), ("closing", 4))
                self.assertGreater(row["closedSeenAt"], time.time() - 30)
        reg = fsn.read_registry(self.padir)
        reg["sessions"][0]["closedSeenAt"] = time.time() - WAIT - 5
        fsn.write_registry(self.padir, reg)
        self.assertEqual(self.run_main("prune")[0], 0)
        self.assertEqual(self.row()["status"], "closed")
        self.assertEqual(self.hc_calls("rm"), [["rm", "alpha/t9"]])

    def test_two_runs_seconds_apart_end_nothing(self):
        self.attempt()
        for _ in range(3):
            self.assertEqual(self.run_main("prune")[0], 0)
        self.assertEqual(self.hc_calls("kill", "rm"), [])
        self.assertEqual(self.row()["status"], "closing")

    def test_the_helper_asks_the_gap_the_number_and_the_old_notice(self):
        now = time.time()
        self.assertTrue(fsn.shell_may_end({"closedSeenAt": now - WAIT, "closedSeenSeq": 4}, now, 4))
        self.assertFalse(fsn.shell_may_end({"closedSeenAt": now - WAIT + 5, "closedSeenSeq": 4}, now, 4))
        self.assertFalse(fsn.shell_may_end({"closedSeenAt": now - 1}, now, 4))
        self.assertFalse(fsn.shell_may_end({"closedSeenAt": now - WAIT - 1, "closedSeenSeq": 4}, now, 5))
        self.assertFalse(fsn.shell_may_end({"closedSeenAt": now - WAIT - 1, "closedSeenSeq": 4}, now, None))
        self.assertFalse(fsn.shell_may_end({"closedSeenAt": now - WAIT - 1, "closedSeenSeq": True}, now, 1))
        self.assertFalse(fsn.shell_may_end({"closedSeenAt": now + 9, "closedSeenSeq": 4}, now, 4))
        closed = {"status": "closed", "closedSeenAt": now - WAIT - 1, "closedSeenSeq": 4}
        self.assertTrue(fsn.shell_may_end(dict(closed, noticeSeq=4), now, 4))
        self.assertFalse(fsn.shell_may_end(dict(closed, noticeSeq=5), now, 4))
        self.assertFalse(fsn.shell_may_end(dict(closed, noticeSeq=True), now, 4))
        last = {"kind": "closed", "at": cp.iso(now - WAIT - 5)}
        self.assertTrue(fsn.shell_may_end({"last": last, "noticeSeq": 4}, now, 4))
        self.assertFalse(fsn.shell_may_end({"last": last, "noticeSeq": 4}, now, 5))
        self.assertFalse(fsn.shell_may_end({"last": last, "noticeSeq": True}, now, 1))
        self.assertFalse(fsn.shell_may_end({"last": last}, now, 4))
        self.assertFalse(fsn.shell_may_end({"last": dict(last, at=cp.iso(now - WAIT + 5)), "noticeSeq": 4}, now, 4))


class DamagedTimeFieldTest(HBase):
    def run_all(self, **extra):
        for argv in (("list",), ("list", "--json"), ("prune",)):
            code, out, err = self.run_main(*argv)
            self.assertEqual(code, 0, err)
            if argv[-1] == "--json":
                self.assertEqual(len(json.loads(out)["sessions"]), 1)

    def test_a_damaged_closed_seen_time_is_ignored_and_rewritten(self):
        for name, bad in BAD_TIMES:
            with self.subTest(name):
                self.seed("closing", closeTriedAt=cp.old(), closedSeenAt=bad, closedSeenSeq=4)
                self.put("alpha/t9", "live", {"fm.notice": CLOSED}, "bash")
                self.run_all()
                self.assertEqual(self.hc_calls("kill", "rm"), [])
                seen = self.row()["closedSeenAt"]
                self.assertTrue(isinstance(seen, float) and 0 < seen <= time.time(), seen)

    def test_a_damaged_tried_time_is_no_expiry(self):
        for name, bad in BAD_TIMES:
            for status in ("closing", "open", "pending"):
                with self.subTest(name=name, status=status):
                    self.seed(status, closeTriedAt=bad)
                    self.put("alpha/t9", "live", {"fm.notice": CLOSED}, "bash")
                    self.run_all()
                    self.assertEqual(self.hc_calls("kill", "rm"), [])
                    self.assertEqual(self.row()["status"], status)

    def test_a_damaged_expiry_mark_is_no_mark_and_force_stays_refused(self):
        for name, bad in BAD_TIMES:
            with self.subTest(name):
                self.seed("open", closeExpiredAt=bad)
                self.put("alpha/t9", "live")
                self.run_all()
                code, out, err = self.run_main("close-remote", "demo", "--force")
                self.assertEqual(code, 1)
                self.assertIn("[not_open]", err)
                self.assertEqual(self.hc_calls("kill", "rm"), [])
                self.assertEqual(self.row()["status"], "open")

    def test_a_damaged_leftover_mark_or_pause_is_ignored(self):
        for field in ("leftAloneAt", "passRetryAt"):
            for name, bad in BAD_TIMES:
                with self.subTest(field=field, name=name):
                    self.seed("closed", noticeSeq=4, **{field: bad})
                    self.put("alpha/t9", "finished", {"fm.notice": CLOSED})
                    self.run_all()

    def test_the_number_helper_never_raises(self):
        for name, bad in BAD_TIMES:
            self.assertIsNone(fsn.number_of(bad), name)
        for good in (0, 1, 1.5, time.time()):
            self.assertEqual(fsn.number_of(good), float(good))
        self.assertIsNone(fsn.number_of(None))
        self.assertIsNone(fsn.number_of(4e12))


class ForceDamagedTimeTest(HBase):
    def test_force_with_a_damaged_tried_time_does_not_crash_and_keeps_the_gate(self):
        for name, bad in BAD_TIMES:
            with self.subTest(name):
                self.seed("open", closeTriedAt=bad)  # no usable mark at all: refused
                self.put("alpha/t9", "live")
                code, out, err = self.run_main("close-remote", "demo", "--force")
                self.assertEqual(code, 1, err)
                self.assertIn("[not_open]", err)
                self.assertNotIn("Traceback", err)
                self.assertEqual(self.hc_calls("kill", "rm"), [])
                self.assertEqual(self.row()["status"], "open")
                self.seed("open", closeTriedAt=bad, closeExpiredAt=time.time() - 30)  # a good mark still opens the gate
                self.put("alpha/t9", "live")
                code, out, err = self.run_main("close-remote", "demo", "--force")
                self.assertEqual((code, self.row()["status"]), (0, "closed"), err)

    def test_force_with_a_damaged_sighting_time_does_not_crash_and_keeps_the_gate(self):
        for name, bad in BAD_TIMES:
            with self.subTest(name):
                self.seed("open", closedSeenAt=bad, closedSeenSeq=4)  # no attempt, no mark: refused
                self.put("alpha/t9", "live", {"fm.notice": CLOSED})
                code, out, err = self.run_main("close-remote", "demo", "--force")
                self.assertEqual(code, 1, err)
                self.assertIn("[not_open]", err)
                self.assertNotIn("Traceback", err)
                self.assertEqual(self.hc_calls("kill", "rm"), [])
                self.assertEqual(self.row()["status"], "open")
                self.seed("open", closedSeenAt=bad, closedSeenSeq=4, closeExpiredAt=time.time() - 30)
                self.put("alpha/t9", "live", {"fm.notice": CLOSED})
                code, out, err = self.run_main("close-remote", "demo", "--force")
                self.assertEqual((code, self.row()["status"]), (0, "closed"), err)


class ForceVariantKTest(HBase):
    def test_an_open_entry_at_expiry_gets_the_mark_and_the_hint_and_force_is_accepted(self):
        self.seed("open", closeTriedAt=cp.old(), lastError="a reason")
        self.put("alpha/t9", "live")
        code, out, err = self.run_main("prune")
        self.assertIn("close for demo@alpha expired without an answer", out)
        self.assertIn("close-remote --force demo", out)
        row = self.row()
        self.assertIsInstance(row["closeExpiredAt"], float)
        self.assertEqual((row["status"], row["lastError"], row["closeTriedAt"]), ("open", "a reason", None))
        code, out, err = self.run_main("close-remote", "demo", "--force")
        self.assertEqual((code, self.row()["status"]), (0, "closed"), err)

    def test_force_is_refused_after_a_notice_since_the_mark(self):
        self.seed("open", closeTriedAt=cp.old())
        self.put("alpha/t9", "live")
        self.run_main("prune")
        reg = fsn.read_registry(self.padir)
        reg["sessions"][0]["last"] = {"kind": "result", "path": "r", "at": cp.iso(time.time() + 60)}
        fsn.write_registry(self.padir, reg)
        code, out, err = self.run_main("close-remote", "demo", "--force")
        self.assertEqual(code, 1)
        self.assertIn("[not_open]", err)
        self.assertEqual(self.hc_calls("kill", "rm"), [])

    def test_a_pending_entry_gets_neither_the_mark_nor_the_line(self):
        self.seed("pending", closeTriedAt=cp.old())
        self.put("alpha/t9", "live")
        code, out, err = self.run_main("prune")
        self.assertNotIn("expired", out)
        self.assertNotIn("closeExpiredAt", self.row())
        self.assertEqual(self.row()["status"], "pending")


class ForceRefusedTest(HBase):
    def test_force_on_a_closed_or_failed_entry_is_refused_and_calls_nothing(self):
        for status in ("closed", "failed"):
            with self.subTest(status):
                self.seed(status, closeTriedAt=time.time() - 30, closeExpiredAt=time.time() - 30)
                self.put("alpha/t9", "live")
                before = self.registry_text()
                code, out, err = self.run_main("close-remote", "demo", "--force")
                self.assertEqual(code, 1)
                self.assertIn("[not_open]", err)
                self.assertEqual(self.hc_calls("get", "rm", "kill", "exec", "machine"), [])
                self.assertEqual(self.registry_text(), before)


class NewAttemptTest(HBase):
    def test_both_attempt_paths_clear_the_sighting(self):
        for env in ({"FAKE_HC_EXEC_MODE": "timed_out"}, {}):
            with self.subTest(env=env):
                self.open_real(closedSeenAt=time.time() - 100, closedSeenSeq=4)
                with mock.patch.object(fsn.time, "sleep"):
                    self.assertEqual(self.run_main("close-remote", "demo", **env)[0], 0 if not env else 1)
                self.assertIsNone(self.row()["closedSeenAt"])
                self.assertIsNone(self.row().get("closedSeenSeq"))


class AddressTableTest(HBase):
    def test_the_shared_table_of_stored_addresses(self):
        for case in CASES["use"]:
            entry = {"machine": case["machine"], "hc": {"address": case["address"]}}
            want = case["address"] if case["ok"] else None
            self.assertEqual(fsn.entry_terminal_address(entry), want, case)

    def test_the_shared_table_of_reported_addresses(self):
        for case in CASES["reply"]:
            self.assertEqual(fsn.reply_address(case["address"], case["machine"]), case["stored"], case)

    def test_an_entry_without_a_machine_keeps_the_plain_check(self):
        self.assertEqual(fsn.entry_terminal_address({"hc": {"address": "t2"}}), "t2")
        self.assertIsNone(fsn.entry_terminal_address({"hc": {"address": "bad address;"}}))
        self.assertIsNone(fsn.entry_terminal_address({}))


class OtherMachineAddressTest(HBase):
    def test_an_edited_address_of_another_machine_is_never_called(self):
        for address in ("beta/t1", "alpha/a/b", "alpha/t1@x", "t1"):
            with self.subTest(address):
                self.fresh(address, closeTriedAt=cp.old())
                self.assertEqual(self.run_main("prune")[0], 0)
                self.assertEqual(self.run_main("list")[0], 0)
                self.assertEqual(self.hc_calls("get", "rm", "kill"), [])
                self.assertIn("demo", self.run_main("prune")[2])
                self.fresh(address)
                self.run_main("close-remote", "demo")
                self.assertEqual(self.hc_calls("get", "rm", "kill"), [])
                self.fresh(address)
                self.run_main("close-remote", "demo", "--force")
                self.assertEqual(self.hc_calls("get", "rm", "kill"), [])
                self.assertEqual(self.terminals()["beta/t1"]["state"], "live")

    def fresh(self, address, **extra):
        self.seed("closing", address=address, **extra)
        self.put("beta/t1", "live", {"fm.notice": CLOSED}, "bash")


class OpenAddressTest(HBase):
    def open_with(self, reply=None, probe=None, **env):
        real = fsn.hc_exec_verb

        def wrapper(binary, name, argv, verb, payload, timeout, deadline=None):
            got = real(binary, name, argv, verb, payload, timeout, deadline)
            if verb == "open" and reply:
                reply(got)
            if verb == "probe" and probe:
                probe(got)
            return got

        with mock.patch.object(fsn, "hc_exec_verb", side_effect=wrapper):
            return self.run_main(*self.open_args(), **env)

    def attach_calls(self):
        return [c for c in self.hc_calls("run") if "attach" in c]

    def test_a_refused_reported_address_fails_the_open_and_stores_no_terminal(self):
        for address in ("other/t1", "a/b/c", "t1@x", "", "x" * 65, "t 1"):
            with self.subTest(address=address):
                self.tmp_registry_reset()
                code, out, err = self.open_with(lambda r: r["hc"].update(address=address), HC_TERMINAL_ID="t0")
                self.assertEqual(code, 1)
                self.assertIn("remote reported no usable terminal address", err)
                self.assertIn("alpha", err)
                self.assertIn("by hand", err)
                (row,) = self.parent_registry()
                self.assertEqual(row["status"], "failed")
                self.assertNotIn("hc", row)
                self.assertNotIn("attach", row)
                self.assertEqual(row["lastError"], "remote reported no usable terminal address")
                self.assertEqual(self.attach_calls(), [])

    def test_the_refused_text_is_printed_without_control_characters(self):
        code, out, err = self.open_with(lambda r: r["hc"].update(address="o\x1b[2Jther/t1"))
        self.assertEqual(code, 1)
        self.assertNotIn("\x1b", err)

    def test_a_bare_id_and_the_own_machine_are_stored_as_machine_slash_id(self):
        for address in ("t1", "alpha/t1"):
            with self.subTest(address):
                self.tmp_registry_reset()
                code, out, err = self.open_with(lambda r: r["hc"].update(address=address))
                self.assertEqual(code, 0, err)
                self.assertEqual(self.parent_registry()[0]["hc"]["address"], "alpha/t1")

    def test_a_refused_address_closes_the_space_this_open_created(self):
        code, out, err = self.open_with(lambda r: r["hc"].update(address="other/t1"), FAKE_APP_SPACES="[]")
        self.assertEqual(code, 1)
        close = [c for c in cp.ft.rr.rt.lines_of(self.logs["app"]) if c[:2] == ["do", "space.close"]]
        self.assertEqual([json.loads(c[2]) for c in close], [{"id": "sp-new", "confirmed": True}])

    def test_a_reply_without_a_terminal_keeps_todays_behaviour(self):
        code, out, err = self.open_with(lambda r: r.pop("hc", None))
        self.assertEqual(code, 0, err)
        self.assertNotIn("hc", self.parent_registry()[0])

    def test_a_bad_remote_handoff_fails_the_open_as_an_invalid_reply_and_stores_nothing(self):
        for value in ("x" * 1025, "/h/a\nb", "/h/a\x1bb", "-rf", "/h/\x7f"):
            with self.subTest(value=value[:12]):
                self.tmp_registry_reset()
                code, out, err = self.open_with(lambda r: r.update(handoff=value))
                self.assertEqual(code, 1)
                self.assertIn("malformed", err)
                self.assertEqual(self.parent_registry(), [])

    def test_a_long_but_clean_remote_handoff_is_kept_whole(self):
        value = "/h/" + "a" * 1000
        code, out, err = self.open_with(lambda r: r.update(handoff=value))
        self.assertEqual(code, 0, err)
        self.assertEqual(self.parent_registry()[0]["remoteHandoff"], value)

    def test_the_version_block_strings_are_stripped_and_cut(self):
        def probe(r):
            r["foremanVersion"] = "1.0\x1b[2J" + "v" * 100
            r["platform"] = {"x": 1}

        code, out, err = self.open_with(None, probe)
        self.assertEqual(code, 0, err)
        block = self.parent_registry()[0]["remote"]
        self.assertEqual(block["foremanVersion"], ("1.0[2J" + "v" * 100)[:64])
        self.assertNotIn("\x1b", json.dumps(block))
        self.assertIsNone(block["platform"])
        self.assertEqual(block["protocol"], fsn.REMOTE_PROTOCOL)

    def tmp_registry_reset(self):
        path = self.padir / "pi-foreman" / "state" / "sessions.json"
        if path.exists():
            path.unlink()
        self.reset_hc()


class LeftoverTest(HBase):
    def leftover(self, **extra):
        extra.setdefault("noticeSeq", 4)
        self.seed("closed", **extra)

    def test_a_finished_leftover_with_the_closed_label_is_removed_at_list_and_marked(self):
        self.leftover()
        self.put("alpha/t9", "finished", {"fm.notice": CLOSED})
        code, out, err = self.run_main("list")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.hc_calls("rm"), [["rm", "alpha/t9"]])
        self.assertTrue(self.row()["reaped"])
        self.assertNotIn("alpha/t9", self.terminals())
        self.run_main("list")
        self.assertEqual(len(self.hc_calls("rm")), 1)

    def test_a_finished_leftover_without_the_label_or_with_another_number_is_left_for_prune(self):
        for labels in ({}, {"fm.notice": "5:closed:-:0"}, {"fm.notice": "4:refused:uncommitted-work"}, {"fm.notice": "junk"}):
            with self.subTest(labels=labels):
                self.leftover()
                self.put("alpha/t9", "finished", labels)
                code, out, err = self.run_main("list")
                self.assertEqual(code, 0, err)
                self.assertEqual(self.hc_calls("rm"), [])
                self.assertIsInstance(self.row()["leftAloneAt"], float)
                self.assertFalse(self.row().get("reaped"))
                self.assertEqual(err.count("left alone demo"), 1, err)
                reads = len(self.hc_get_calls())
                self.run_main("list")
                self.assertEqual(len(self.hc_get_calls()), reads)
                self.assertEqual(self.run_main("prune")[0], 0)
                self.assertEqual(self.hc_calls("rm"), [["rm", "alpha/t9"]])

    def test_a_recorded_number_of_true_is_no_match(self):
        self.leftover(noticeSeq=True)
        self.put("alpha/t9", "finished", {"fm.notice": "1:closed:-:0"})
        self.run_main("list")
        self.assertEqual(self.hc_calls("rm"), [])
        self.assertIsInstance(self.row()["leftAloneAt"], float)

    def test_a_gone_leftover_is_marked_without_a_removal(self):
        self.leftover()
        self.assertEqual(self.run_main("list")[0], 0)
        self.assertEqual(self.hc_calls("rm"), [])
        self.assertTrue(self.row()["reaped"])

    def test_a_live_leftover_without_the_label_is_named_once_and_not_read_again_but_prune_handles_it(self):
        self.leftover()
        self.put("alpha/t9", "live", {}, "bash")
        code, out, err = self.run_main("list")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.hc_calls("kill", "rm"), [])
        self.assertIsInstance(self.row()["leftAloneAt"], float)
        self.assertEqual(err.count("left alone demo"), 1, err)
        reads = len(self.hc_get_calls())
        self.run_main("list")
        self.assertEqual(len(self.hc_get_calls()), reads)
        self.assertEqual(self.run_main("prune")[0], 0)
        self.assertGreater(len(self.hc_get_calls()), reads)
        self.assertEqual(self.hc_calls("kill", "rm"), [])

    def test_a_live_leftover_with_another_label_number_is_left_alone(self):
        self.leftover()
        self.put("alpha/t9", "live", {"fm.notice": "5:closed:-:0"}, "bash")
        self.run_main("list")
        self.assertEqual(self.hc_calls("kill", "rm"), [])
        self.assertIsInstance(self.row()["leftAloneAt"], float)

    def test_a_live_leftover_with_the_label_waits_for_the_gap_and_then_ends_a_shell(self):
        self.leftover()
        self.put("alpha/t9", "live", {"fm.notice": CLOSED}, "bash")
        self.assertEqual(self.run_main("list")[0], 0)
        row = self.row()
        self.assertEqual((row["closedSeenSeq"], row["status"], row.get("leftAloneAt")), (4, "closed", None))
        self.assertIsInstance(row["closedSeenAt"], float)
        self.assertEqual(self.hc_calls("kill", "rm"), [])
        self.run_main("list")
        self.assertEqual(self.hc_calls("kill", "rm"), [])
        reg = fsn.read_registry(self.padir)
        reg["sessions"][0]["closedSeenAt"] = time.time() - WAIT - 5
        fsn.write_registry(self.padir, reg)
        self.assertEqual(self.run_main("list")[0], 0)
        self.assertEqual((self.row()["status"], self.row()["reaped"]), ("closed", True))
        self.assertEqual(self.hc_calls("rm"), [["rm", "alpha/t9"]])
        self.assertNotIn("alpha/t9", self.terminals())

    def test_a_live_leftover_with_an_old_closed_notice_ends_a_shell_at_once(self):
        self.leftover(last={"kind": "closed", "at": cp.iso(time.time() - WAIT - 30)})
        self.put("alpha/t9", "live", {"fm.notice": CLOSED}, "zsh")
        self.assertEqual(self.run_main("list")[0], 0)
        self.assertTrue(self.row()["reaped"])
        self.assertEqual(self.hc_calls("rm"), [["rm", "alpha/t9"]])

    # What was checked (the residual risk is stated at `settle_live`): on one platform, by experiment, a process started
    # detached without stdio (as the closing child starts its cleanup) was not reported as the terminal's foreground program.
    # Windows was not checked (no machine name).
    def busy(self, status, seen_age, labels=None, **extra):
        if status == "closed":
            self.leftover(**extra)
        else:
            self.seed(status, closeTriedAt=cp.old(), **extra)
        if seen_age is not None:
            reg = fsn.read_registry(self.padir)
            reg["sessions"][0].update(closedSeenAt=time.time() - seen_age, closedSeenSeq=4)
            fsn.write_registry(self.padir, reg)
        self.put("alpha/t9", "live", {"fm.notice": CLOSED} if labels is None else labels, "node.exe")

    def test_the_pass_ends_a_busy_program_after_the_label_and_the_wait(self):
        for status in ("closing", "open", "closed"):
            with self.subTest(status):
                self.busy(status, WAIT + 5)
                self.assertEqual(self.run_main("list")[0], 0)
                row = self.row()
                self.assertEqual(row["status"], "closed")
                self.assertTrue(row.get("reaped"))
                self.assertIn(["kill", "alpha/t9"], self.hc_calls("kill"))
                self.assertEqual(self.hc_calls("rm"), [["rm", "alpha/t9"]])
                self.assertNotIn("alpha/t9", self.terminals())

    def test_the_pass_ends_a_busy_program_on_an_old_closed_notice(self):
        self.busy("closed", None, last={"kind": "closed", "at": cp.iso(time.time() - WAIT - 30)})
        self.assertEqual(self.run_main("list")[0], 0)
        self.assertTrue(self.row()["reaped"])
        self.assertEqual(self.hc_calls("rm"), [["rm", "alpha/t9"]])

    def test_the_pass_ends_no_busy_program_before_the_wait(self):
        for status in ("open", "closed"):
            with self.subTest(status):
                self.busy(status, WAIT - 30)
                self.run_main("list")
                self.assertEqual(self.hc_calls("kill", "rm"), [])
                self.assertFalse(self.row().get("reaped"))
                self.assertIn("alpha/t9", self.terminals())

    def test_the_pass_ends_no_busy_program_with_another_number(self):
        for status in ("open", "closed"):
            with self.subTest(status):
                self.busy(status, WAIT + 5, labels={"fm.notice": "5:closed:-:0"})
                self.run_main("list")
                self.assertEqual(self.hc_calls("kill", "rm"), [])
                self.assertFalse(self.row().get("reaped"))
                self.assertIn("alpha/t9", self.terminals())

    def test_the_pass_ends_no_busy_program_without_the_label(self):
        for status in ("open", "closed"):
            for labels in ({}, {"fm.notice": "4:refused:uncommitted-work"}, {"fm.notice": "junk"}):
                with self.subTest(status=status, labels=labels):
                    self.busy(status, WAIT + 5, labels=labels, last={"kind": "closed", "at": cp.iso(time.time() - WAIT - 30)})
                    self.run_main("list")
                    self.assertEqual(self.hc_calls("kill", "rm"), [])
                    self.assertFalse(self.row().get("reaped"))
                    self.assertIn("alpha/t9", self.terminals())

    def test_a_shared_address_with_a_live_entry_is_not_touched(self):
        self.rows(("old", "closed", "alpha/t9", {"noticeSeq": 4}), ("new", "open", "alpha/t9", {}))
        self.put("alpha/t9", "finished", {"fm.notice": CLOSED})
        self.assertEqual(self.run_main("list")[0], 0)
        self.no_remote_calls()

    def test_list_without_an_expired_attempt_or_an_unmarked_closed_entry_makes_no_call(self):
        self.rows(("a", "closed", "alpha/t1", {"reaped": True}), ("b", "closed", "alpha/t2", {"leftAloneAt": time.time()}),
                  ("c", "closed", "alpha/t3", {"reaped": True, "passRetryAt": time.time()}), ("d", "open", "alpha/t4", {}),
                  ("e", "closing", "alpha/t5", {"closeTriedAt": time.time()}))
        self.put("alpha/t2", "live")
        for argv in (("list",), ("list", "--json")):
            self.assertEqual(self.run_main(*argv)[0], 0)
        self.no_remote_calls()

    def test_list_json_with_a_leftover_stays_one_document(self):
        self.leftover()
        self.put("alpha/t9", "finished", {"fm.notice": CLOSED})
        code, out, err = self.run_main("list", "--json")
        self.assertEqual(code, 0, err)
        self.assertTrue(json.loads(out)["sessions"][0]["reaped"])
        self.assertIn("reaped demo", err)

    def test_the_attach_terminal_goes_with_the_removed_terminal(self):
        self.leftover(attach={"address": "t3"})
        self.put("alpha/t9", "finished", {"fm.notice": CLOSED})
        self.run_main("list")
        self.assertIn(["kill", "t3"], self.hc_calls("kill"))


class RetryPauseTest(HBase):
    def three(self, **extra):
        self.rows(("c", "open", "alpha/t3", dict(closeTriedAt=cp.old(), **extra)),
                  ("a", "closed", "alpha/t1", {"noticeSeq": 4}), ("b", "closed", "alpha/t2", {"noticeSeq": 4}))

    def test_a_failed_read_pauses_the_entry_and_the_skipped_ones_of_its_machine(self):
        self.three()
        code, out, err = self.run_main("list", FAKE_HC_FAIL="1")
        self.assertEqual(code, 0, err)
        self.assertEqual(len(self.hc_get_calls()), 1)
        for label in "abc":
            self.assertIsInstance(self.row_of(label)["passRetryAt"], float, label)
        for label in "abc":
            self.assertIn(label, err)
        calls = len(self.hc_calls("get", "rm", "kill"))
        code, out, err = self.run_main("list")
        self.assertEqual(len(self.hc_calls("get", "rm", "kill")), calls)
        self.assertIn("c, a, b", err)

    def test_prune_close_remote_and_force_ignore_the_pause(self):
        self.three()
        self.run_main("list", FAKE_HC_FAIL="1")
        reads = len(self.hc_get_calls())
        self.assertEqual(self.run_main("prune")[0], 0)
        self.assertGreater(len(self.hc_get_calls()), reads)
        self.assertEqual(self.row_of("c")["status"], "closed")
        self.open_real(passRetryAt=time.time())
        self.assertEqual(self.run_main("close-remote", "demo")[0], 0)
        self.assertEqual(self.row()["status"], "closing")
        self.seed("closing", passRetryAt=time.time())
        self.assertEqual(self.run_main("close-remote", "demo", "--force")[0], 0)
        self.assertEqual(self.row()["status"], "closed")

    def test_a_pause_skips_a_leftover_and_an_expired_attempt_without_a_read_and_names_them(self):
        now = time.time()
        self.rows(("a", "closed", "alpha/t1", {"noticeSeq": 4, "passRetryAt": now - 10}),
                  ("c", "open", "alpha/t3", {"closeTriedAt": cp.old(), "passRetryAt": now - 10}))
        code, out, err = self.run_main("list")
        self.assertEqual(code, 0, err)
        self.no_remote_calls()
        self.assertIn("a", err)
        self.assertIn("c", err)

    def test_a_pause_in_the_future_or_damaged_or_old_is_no_pause(self):
        for value in (time.time() + 1000, "x", True, None, time.time() - fsn.PASS_RETRY_PAUSE - 5):
            with self.subTest(value=value):
                self.rows(("a", "closed", "alpha/t1", {"noticeSeq": 4, "passRetryAt": value}))
                self.assertEqual(self.run_main("list")[0], 0)
                self.assertTrue(self.row_of("a")["reaped"])

    def test_a_failed_removal_records_the_pause(self):
        self.rows(("a", "closed", "alpha/t1", {"noticeSeq": 4}))
        self.put("alpha/t1", "finished", {"fm.notice": CLOSED})
        with self.wrap_run(fail_verbs=("rm",)):
            self.assertEqual(self.run_main("list")[0], 0)
        self.assertIsInstance(self.row_of("a")["passRetryAt"], float)
        self.assertFalse(self.row_of("a").get("reaped"))
        calls = len(self.hc_calls("get", "rm"))
        self.run_main("list")
        self.assertEqual(len(self.hc_calls("get", "rm")), calls)

    def test_a_failed_kill_records_the_pause(self):
        self.rows(("a", "closed", "alpha/t1", {"noticeSeq": 4, "closedSeenAt": time.time() - WAIT - 5, "closedSeenSeq": 4}))
        self.put("alpha/t1", "live", {"fm.notice": CLOSED}, "bash")
        with self.wrap_run(fail_verbs=("kill",)):
            self.assertEqual(self.run_main("list")[0], 0)
        self.assertIsInstance(self.row_of("a")["passRetryAt"], float)
        self.assertEqual(self.row_of("a")["status"], "closed")

    def test_an_offline_machine_keeps_the_list_within_the_limit_and_the_next_list_goes_on(self):
        rows = [("m%d" % i, "closed", "m%d/t1" % i, {"noticeSeq": 4, "machine": "m%d" % i}) for i in range(30)]
        self.rows(*rows)
        reg = fsn.read_registry(self.padir)
        for s in reg["sessions"]:
            s["machine"] = s["label"]
        fsn.write_registry(self.padir, reg)
        clock, seen = ft.Clock(), []

        def hang(cmd, **kw):
            seen.append(cmd[2])
            clock.t += kw["timeout"]
            raise subprocess.TimeoutExpired(cmd, kw["timeout"])

        runs = []
        for _ in range(2):
            seen.clear()
            start = clock.t
            with mock.patch.object(fsn.time, "monotonic", clock.monotonic), mock.patch.object(fsn.time, "sleep", clock.sleep), \
                    mock.patch.object(fsn.subprocess, "run", side_effect=hang):
                code, out, err = self.run_main("list")
            self.assertEqual(code, 0, err)
            self.assertLessEqual(clock.t - start, fsn.PASS_TOTAL_LIMIT + 1)
            runs.append(set(seen))
        self.assertTrue(runs[0] and runs[1])
        self.assertEqual(runs[0] & runs[1], set())


class ClosedByThePassTest(HBase):
    def test_an_entry_closed_from_a_sighting_carries_the_label_number(self):
        self.seed("open", closeTriedAt=cp.old(), closedSeenAt=time.time() - WAIT - 5, closedSeenSeq=4)
        self.put("alpha/t9", "live", {"fm.notice": CLOSED}, "bash")
        self.assertEqual(self.run_main("prune")[0], 0)
        row = self.row()
        self.assertEqual((row["status"], row["noticeSeq"], row["last"]["kind"]), ("closed", 4, "closed"))
        self.assertEqual(row["last"]["at"][-1], "Z")

    def test_end_shell_reaches_the_removal_with_a_machine_entry(self):
        self.seed("closed")
        self.put("alpha/t9", "live", {}, "bash")
        entry = self.row()
        with contextlib.ExitStack() as stack:
            self.apply_env({}, stack)
            stack.enter_context(mock.patch.object(fsn.time, "sleep"))
            self.assertTrue(fsn.end_shell(fsn.hc_bin(), entry, fsn.Deadline(30)))
            self.assertFalse(fsn.end_shell(fsn.hc_bin(), dict(entry, hc={"address": "beta/t9"}), fsn.Deadline(30)))
        self.assertNotIn("alpha/t9", self.terminals())


class NormalCloseTest(HBase):
    def test_close_remote_marks_the_terminal_reaped_when_it_removed_it(self):
        self.open_real()
        self.put("alpha/t1", "finished")
        self.assertEqual(self.run_main("close-remote", "demo")[0], 0)
        self.assertTrue(self.row()["reaped"])

    def test_close_remote_does_not_mark_a_live_terminal(self):
        self.open_real()
        self.put("alpha/t1", "live")
        with mock.patch.object(fsn.time, "sleep"):
            self.assertEqual(self.run_main("close-remote", "demo")[0], 0)
        self.assertFalse(self.row().get("reaped"))


class AddressResolutionTest(HBase):
    def opened(self, label="demo", machine="alpha", **extra):
        code, out, err = self.run_main("open", label, str(self.brief), "--machine", machine, "--cwd", str(self.rproj),
                                       "--parent-id", cp.ft.rr.rt.PARENT, **extra)
        self.assertEqual(code, 0, err)
        return out

    def test_the_open_output_has_the_address_line(self):
        out = self.opened()
        self.assertIn("address: demo@alpha", out.splitlines())

    def test_close_remote_and_brief_resolve_the_address(self):
        self.opened()
        code, out, err = self.run_main("brief", "demo@alpha", "more", "--parent-id", cp.ft.rr.rt.PARENT)
        self.assertEqual(code, 0, err)
        self.assertEqual(self.row()["briefs"], 1)
        code, out, err = self.run_main("close-remote", "demo@alpha")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.row()["status"], "closing")
        self.seed("closing")
        code, out, err = self.run_main("close-remote", "demo@alpha", "--force")
        self.assertEqual((code, self.row()["status"]), (0, "closed"), err)

    def test_the_newest_entry_with_that_label_and_machine_wins_and_a_bare_label_is_unchanged(self):
        self.rows(("x", "open", "alpha/t1", {}), ("x", "open", "beta/t2", {"machine": "beta", "child": "fm-x-2"}),
                  ("x", "closed", "alpha/t3", {"child": "fm-x-3"}))
        self.assertEqual(fsn.find_entry(self.padir, "x@alpha")["child"], "fm-x-3")
        self.assertEqual(fsn.find_entry(self.padir, "x@beta")["child"], "fm-x-2")
        self.assertEqual(fsn.find_entry(self.padir, "x")["child"], "fm-x-3")

    def test_a_child_id_with_an_at_sign_still_matches_exactly_first(self):
        self.rows(("x", "open", "alpha/t1", {"child": "x@alpha"}), ("y", "open", "alpha/t2", {"label": "x", "child": "fm-y-1"}))
        self.assertEqual(fsn.find_entry(self.padir, "x@alpha")["child"], "x@alpha")

    def test_an_unknown_address_is_refused_with_the_known_candidates(self):
        self.rows(("demo", "open", "alpha/t1", {}), ("other", "open", "alpha/t2", {"child": "fm-o-1"}))
        for target in ("demo@nomachine", "nolabel@alpha"):
            with self.subTest(target):
                code, out, err = self.run_main("close-remote", target)
                self.assertEqual(code, 1)
                self.assertIn("demo@alpha", err)
                code, out, err = self.run_main("brief", target, "x", "--parent-id", cp.ft.rr.rt.PARENT)
                self.assertEqual(code, 1)
                self.assertIn("demo@alpha", err)
        self.assertEqual(self.hc_calls("exec", "get", "kill", "rm"), [])

    def test_brief_tries_a_handoff_directory_named_with_an_at_sign_before_refusing(self):
        d = self.tmp / "x@y"
        d.mkdir()
        (d / "child").write_text("fm-x-abc123\n", "utf-8")
        code, out, err = self.run_main("brief", str(d), "hello", "--parent-id", cp.ft.rr.rt.PARENT)
        self.assertEqual(code, 0, err)

    def test_the_cli_row_of_a_machine_entry_shows_the_address_before_the_hc_part(self):
        self.opened()
        row = [l for l in self.run_main("list")[1].splitlines() if l.strip().startswith("demo")][0]
        self.assertTrue(row.rstrip().endswith("demo@alpha hc:alpha/t1"), row)
        self.assertIn(self.parent_registry()[0]["child"] + " demo@alpha", row)

    def test_a_row_with_a_last_report_keeps_it_last_and_a_local_row_is_unchanged(self):
        self.rows(("m", "open", "alpha/t1", {"last": {"kind": "result", "path": "r.md"}}))
        reg = fsn.read_registry(self.padir)
        reg["sessions"].append({"label": "loc", "child": "fm-loc-1", "status": "open", "handoff": "/h/loc", "model": None})
        fsn.write_registry(self.padir, reg)
        out = self.run_main("list")[1]
        rows = {l.split()[0]: l for l in out.splitlines()[1:]}
        self.assertTrue(rows["m"].endswith("m@alpha hc:alpha/t1 last: result r.md"), rows["m"])
        self.assertEqual(rows["loc"], "  loc  -  open  /h/loc  fm-loc-1")


class LocalCopyTest(HBase):
    def test_close_the_pass_and_prune_delete_no_file_in_the_local_copy(self):
        self.assertEqual(self.run_main(*self.open_args(), HC_TERMINAL_ID="t0")[0], 0)
        mirror = Path(self.row()["mirror"])
        for name in ("plan.md", "result.md", "ask.md", "result.md.partial", "x.tmp"):
            (mirror / name).write_text("data\n", "utf-8")
        listing = sorted(p.name for p in mirror.iterdir())
        self.assertEqual(self.run_main("close-remote", "demo")[0], 0)
        self.assertEqual(sorted(p.name for p in mirror.iterdir()), listing)
        reg = fsn.read_registry(self.padir)
        reg["sessions"][0].update(status="closing", closeTriedAt=cp.old())
        fsn.write_registry(self.padir, reg)
        self.put("alpha/t1", "finished")
        self.assertEqual(self.run_main("list")[0], 0)
        self.assertEqual(self.run_main("prune")[0], 0)
        self.assertEqual(self.row()["status"], "closed")
        self.assertEqual(sorted(p.name for p in mirror.iterdir()), listing)


if __name__ == "__main__":
    unittest.main()
