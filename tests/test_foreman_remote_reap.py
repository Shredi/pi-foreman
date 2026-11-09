"""Remote terminal reaping: close-remote, prune and `close-remote --force` remove the finished `--keep` terminal of a machine
entry; foreman_close.in_use_by ignores machine entries on their way out."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))
import test_foreman_session_remote as rt  # noqa: E402

fsn = rt.fsn
sys.path.insert(0, str(TESTS.parent / "scripts"))
import foreman_close as fcl  # noqa: E402


class ReapBase(rt.RemoteBase):
    def terminals_path(self):
        return self.tmp / "hcstate" / "terminals.json"

    def terminals(self):
        p = self.terminals_path()
        return json.loads(p.read_text("utf-8")) if p.exists() else {}

    def set_terminal(self, address, state):
        t = self.terminals()
        t[address] = {"address": address, "state": state, "labels": {}}
        self.terminals_path().parent.mkdir(parents=True, exist_ok=True)
        self.terminals_path().write_text(json.dumps(t), "utf-8")

    def seed(self, status, address="alpha/t9", label="demo", **extra):
        entry = {"label": label, "child": "fm-%s-abc123" % label, "status": status, "machine": "alpha",
                 "hc": {"address": address, "space": None, "tab": None}, "handoff": "/h/x"}
        entry.update(extra)
        path = self.padir / "pi-foreman" / "state" / "sessions.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"version": 1, "sessions": [entry]}), "utf-8")

    def row(self):
        return self.parent_registry()[0]


class PruneReapTest(ReapBase):
    def test_closing_with_a_finished_terminal_is_removed_and_closed(self):
        self.seed("closing")
        self.set_terminal("alpha/t9", "finished")
        code, out, err = self.run_main("prune")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.hc_calls("rm"), [["rm", "alpha/t9"]])
        self.assertEqual(self.row()["status"], "closed")
        self.assertNotIn("alpha/t9", self.terminals())

    def test_closed_with_a_leftover_terminal_is_removed_once(self):
        self.seed("closed")
        self.set_terminal("alpha/t9", "finished")
        self.assertEqual(self.run_main("prune")[0], 0)
        self.assertEqual(self.run_main("prune")[0], 0)
        self.assertEqual(self.hc_calls("rm"), [["rm", "alpha/t9"]])
        self.assertEqual(self.row()["status"], "closed")
        self.assertTrue(self.row()["reaped"])

    def test_closing_with_a_gone_terminal_is_closed_without_rm(self):
        self.seed("closing")
        code, out, err = self.run_main("prune")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.hc_calls("rm"), [])
        self.assertEqual(self.row()["status"], "closed")

    def test_a_live_terminal_is_left_alone(self):
        self.seed("closing")
        self.set_terminal("alpha/t9", "live")
        self.assertEqual(self.run_main("prune")[0], 0)
        self.assertEqual(self.hc_calls("rm"), [])
        self.assertEqual(self.row()["status"], "closing")

    def test_an_open_entry_is_not_touched(self):
        self.seed("open")
        self.set_terminal("alpha/t9", "finished")
        self.assertEqual(self.run_main("prune")[0], 0)
        self.assertEqual(self.hc_calls("rm"), [])
        self.assertEqual(self.row()["status"], "open")


class ForceTest(ReapBase):
    def test_force_kills_a_live_terminal_removes_it_and_closes(self):
        self.seed("closing", attach={"address": "t3"})
        self.set_terminal("alpha/t9", "live")
        code, out, err = self.run_main("close-remote", "demo", "--force")
        self.assertEqual(code, 0, err)
        self.assertIn(["kill", "alpha/t9"], self.hc_calls("kill"))
        self.assertIn(["kill", "t3"], self.hc_calls("kill"))
        self.assertEqual(self.hc_calls("rm"), [["rm", "alpha/t9"]])
        self.assertEqual(self.row()["status"], "closed")

    def test_force_on_a_finished_terminal_does_not_kill_it(self):
        self.seed("closing")
        self.set_terminal("alpha/t9", "finished")
        self.assertEqual(self.run_main("close-remote", "demo", "--force")[0], 0)
        self.assertNotIn(["kill", "alpha/t9"], self.hc_calls("kill"))
        self.assertEqual(self.row()["status"], "closed")

    def test_closing_is_refused_without_force(self):
        self.seed("closing")
        code, out, err = self.run_main("close-remote", "demo")
        self.assertEqual(code, 1)
        self.assertIn("not_open", err)
        self.assertEqual(self.row()["status"], "closing")


class CloseRemoteReapTest(ReapBase):
    def opened_address(self):
        self.assertEqual(self.run_main(*self.open_args())[0], 0)
        return self.row()["hc"]["address"]

    def test_a_finished_terminal_is_removed_after_close(self):
        address = self.opened_address()
        self.set_terminal(address, "finished")
        code, out, err = self.run_main("close-remote", "demo")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.hc_calls("rm"), [["rm", address]])
        self.assertNotIn("still running", err)

    def test_a_running_terminal_is_reported_after_the_bounded_poll(self):
        address = self.opened_address()
        self.set_terminal(address, "live")
        with mock.patch.object(fsn.time, "sleep") as sleep:
            code, out, err = self.run_main("close-remote", "demo")
        self.assertEqual(code, 0, err)
        self.assertEqual(sleep.call_count, fsn.REAP_POLLS)
        self.assertEqual(self.hc_calls("rm"), [])
        self.assertIn("remote terminal still running; prune will remove it", err)
        self.assertEqual(self.row()["status"], "closing")


class InUseByTest(unittest.TestCase):
    def test_machine_entries_closing_or_closed_do_not_hold_a_local_dir(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            wt = Path(d) / "wt"
            wt.mkdir()
            state = Path(d) / "state"
            state.mkdir()
            for status in ("closing", "closed"):
                entry = {"label": "r", "child": "c1", "status": status, "machine": "alpha", "cwd": str(wt)}
                (state / "sessions.json").write_text(json.dumps({"sessions": [entry]}), "utf-8")
                self.assertIsNone(fcl.in_use_by(str(state), "caller", str(wt)), status)
            entry = {"label": "r", "child": "c1", "status": "open", "cwd": str(wt)}
            (state / "sessions.json").write_text(json.dumps({"sessions": [entry]}), "utf-8")
            self.assertEqual(fcl.in_use_by(str(state), "caller", str(wt)), "c1")


class UnknownReapReportedTest(ReapBase):
    def test_close_remote_warns_when_hc_fails_but_stays_rc0(self):
        self.assertEqual(self.run_main(*self.open_args())[0], 0)
        with mock.patch.object(fsn, "reap_remote_terminal", return_value="unknown"):
            code, out, err = self.run_main("close-remote", "demo")
        self.assertEqual(code, 0, err)
        self.assertIn("could not be removed (hc get/rm failed)", err)
        self.assertEqual(self.row()["status"], "closing")

    def test_prune_warns_once_for_several_unknown_entries(self):
        self.seed("closed")
        code, out, err = self.run_main("prune", FAKE_HC_FAIL="1")
        self.assertEqual(code, 0, err)
        self.assertEqual(err.count("could not be removed"), 1)
        self.assertEqual(self.row()["status"], "closed")

    def test_prune_warns_for_a_closing_entry_too(self):
        self.seed("closing")
        code, out, err = self.run_main("prune", FAKE_HC_FAIL="1")
        self.assertEqual(code, 0, err)
        self.assertIn("could not be removed", err)
        self.assertEqual(self.row()["status"], "closing")


class RmNotFoundTest(unittest.TestCase):
    def run_with(self, rm_rc, rm_err):
        def fake_run(cmd, **kw):
            if cmd[1] == "rm":
                return mock.Mock(returncode=rm_rc, stdout=b"", stderr=rm_err)
            return mock.Mock(returncode=0, stdout=b'{"state": "finished"}', stderr=b"")
        entry = {"hc": {"address": "alpha/t9"}}
        with mock.patch.object(fsn, "hc_bin", return_value="/x/hc"), \
                mock.patch.object(fsn.subprocess, "run", side_effect=fake_run):
            return fsn.reap_remote_terminal(entry)

    def test_rm_not_found_means_gone(self):
        self.assertEqual(self.run_with(3, b'{"error": {"kind": "not_found"}}'), "gone")

    def test_other_rm_failure_is_unknown(self):
        self.assertEqual(self.run_with(1, b"boom"), "unknown")
        self.assertEqual(self.run_with(3, b"boom"), "unknown")


class ForceDropTest(ReapBase):
    def test_force_drops_with_a_warning_when_hc_fails(self):
        self.seed("closing")
        code, out, err = self.run_main("close-remote", "demo", "--force", FAKE_HC_FAIL="1")
        self.assertEqual(code, 0, err)
        self.assertIn("was not removed", err)
        self.assertIn("marked closed anyway", err)
        self.assertEqual(self.row()["status"], "closed")
        self.assertTrue(self.row()["reaped"])

    def test_force_drops_with_a_warning_when_the_address_is_invalid(self):
        self.seed("closing", address="bad address;")
        code, out, err = self.run_main("close-remote", "demo", "--force")
        self.assertEqual(code, 0, err)
        self.assertIn("no usable remote terminal address", err)
        self.assertEqual(self.row()["status"], "closed")

    def test_a_clean_force_prints_no_warning(self):
        self.seed("closing")
        self.set_terminal("alpha/t9", "finished")
        code, out, err = self.run_main("close-remote", "demo", "--force")
        self.assertEqual(code, 0, err)
        self.assertNotIn("was not removed", err)


if __name__ == "__main__":
    unittest.main()
