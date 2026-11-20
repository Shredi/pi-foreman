"""`foreman session restart`: a local child (hc terminal, Pi as its program) and a child on another machine (remote verb)."""
from __future__ import annotations

import json
import os
import shutil
import sys
import time
from pathlib import Path
from unittest import mock

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))
from test_foreman_session_remote import RemoteBase  # noqa: E402
import foreman_session as fsn  # noqa: E402

CHILD = "fm-demo-abc123"
PARENT_ID = "pid-parent-0001"
SID = "sess-aaaa1111"


class LocalRestartBase(RemoteBase):
    def setUp(self):
        super().setUp()
        self.proj = self.tmp / "proj"
        self.proj.mkdir()
        self.hand = self.padir / "pi-foreman" / "handoffs" / "20260101-000000-demo"
        self.hand.mkdir(parents=True)
        (self.hand / "parent").write_text(PARENT_ID + "\n", "utf-8")
        (self.hand / "child").write_text(CHILD + "\n", "utf-8")
        (self.hand / "brief.md").write_text("# Task\n", "utf-8")
        (self.hand / "live.json").write_text(json.dumps({"piSessionId": SID}), "utf-8")
        self.sfile = self.padir / "sessions" / "--proj--" / ("2026-01-01T00-00-00_%s.jsonl" % SID)
        self.sfile.parent.mkdir(parents=True)
        self.identity = {"v": 1, "piSessionId": SID, "child": CHILD, "parentLabel": "boss", "handoff": str(self.hand),
                         "model": None, "remoteParent": None, "sessionName": None, "permsProfile": "strict",
                         "planPhase": "1", "bgEnv": {"PI_BG_SHELL": "zsh"}}
        self.sfile.write_text(json.dumps({"type": "custom", "customType": "pi-foreman-identity", "data": self.identity}) + "\n", "utf-8")
        self.hcstate = Path(self.env["FAKE_HC_STATE"])
        self.env["HC_TERMINAL_ID"] = "t0"
        self.entry = {"label": "demo", "child": CHILD, "handoff": str(self.hand), "status": "open", "backend": "hc",
                      "cwd": str(self.proj), "parent": PARENT_ID, "hc": {"address": "t1", "parent": "t0", "space": None}}
        self.set_terminals({"t1": {"address": "t1", "name": fsn.hc_name(CHILD), "state": "finished", "labels": {}}})

    def set_terminals(self, terminals):
        self.hcstate.mkdir(parents=True, exist_ok=True)
        (self.hcstate / "terminals.json").write_text(json.dumps(terminals), "utf-8")
        (self.hcstate / "counter").write_text(str(max([int(a[1:]) for a in terminals] or [0])), "utf-8")

    def terminals(self):
        return json.loads((self.hcstate / "terminals.json").read_text("utf-8"))

    def write_entry(self, **over):
        self.entry.update(over)
        fsn.write_registry(self.padir, {"sessions": [self.entry]})

    def stored(self):
        return fsn.read_registry(self.padir)["sessions"][0]

    def restart(self, target="demo", *extra, **env):
        return self.run_main("restart", target, *extra, **env)

    def run_head(self):
        (call,) = self.hc_calls("run")
        return call[:call.index("--")], call[call.index("--") + 1:]


class RestartLocalTest(LocalRestartBase):
    def setUp(self):
        super().setUp()
        self.write_entry()

    def refused(self, text):
        code, out, err = self.restart()
        self.assertEqual(code, 1, out)
        self.assertIn(text, out + err)
        self.assertEqual(self.hc_calls("run"), [])

    def test_restart_starts_pi_in_a_new_kept_terminal_and_updates_the_address(self):
        with mock.patch.object(fsn, "hc_terminal_addresses", return_value={"t0"}):
            code, out, err = self.restart()
        self.assertEqual(code, 0, err)
        head, argv = self.run_head()
        self.assertIn("--keep", head)
        self.assertEqual(head[head.index("--name") + 1], fsn.hc_name(CHILD))
        self.assertEqual(head[head.index("--cwd") + 1], str(self.proj))
        self.assertIn(str(self.sfile), argv)
        self.assertIn("--session", argv)
        stored = self.stored()
        self.assertEqual((stored["status"], stored["hc"]["address"]), ("open", "t2"))

    def test_no_space_label_and_no_no_parent(self):
        with mock.patch.object(fsn, "hc_terminal_addresses", return_value={"t0"}):
            self.restart()
        head, _ = self.run_head()
        self.assertFalse(any(a.startswith("herdr.") for a in head))
        self.assertNotIn("--no-parent", head)

    def test_parent_terminal_passed_when_live(self):
        with mock.patch.object(fsn, "hc_terminal_addresses", return_value={"t0"}):
            self.restart()
        head, _ = self.run_head()
        self.assertEqual(head[head.index("--parent") + 1], "t0")
        self.assertEqual(self.stored()["hc"]["parent"], "t0")

    def test_parent_terminal_left_out_when_gone(self):
        with mock.patch.object(fsn, "hc_terminal_addresses", return_value=set()):
            self.restart()
        head, _ = self.run_head()
        self.assertNotIn("--parent", head)

    def test_env_is_rebuilt_from_the_identity_entry(self):
        with mock.patch.object(fsn, "hc_terminal_addresses", return_value={"t0"}):
            self.restart()
        _, argv = self.run_head()
        words = " ".join(argv)
        for want in ("PI_FOREMAN_HANDOFF_DIR=%s" % self.hand, "PI_FOREMAN_PARENT_INTERCOM=" + PARENT_ID,
                     "PI_INTERCOM_STABLE_ID=" + CHILD, "PI_FOREMAN_PARENT_LABEL=boss", "PI_FOREMAN_PERMS_PROFILE=strict",
                     "PI_FOREMAN_PLAN_PHASE=1", "PI_BG_SHELL=zsh"):
            self.assertIn(want, words)

    def test_finished_old_terminal_is_removed(self):
        with mock.patch.object(fsn, "hc_terminal_addresses", return_value=set()):
            self.restart()
        self.assertNotIn("t1", self.terminals())
        self.assertEqual(self.hc_calls("kill"), [])

    def test_live_shell_with_pi_gone_is_killed_and_removed(self):
        self.set_terminals({"t1": {"address": "t1", "name": fsn.hc_name(CHILD), "state": "live", "labels": {}}})
        with mock.patch.object(fsn, "hc_terminal_addresses", return_value=set()):
            self.restart()
        self.assertEqual([c[1] for c in self.hc_calls("kill")], ["t1"])
        self.assertNotIn("t1", self.terminals())

    def test_terminal_with_another_name_is_left_alone(self):
        self.set_terminals({"t1": {"address": "t1", "name": "someone-else", "state": "live", "labels": {}}})
        with mock.patch.object(fsn, "hc_terminal_addresses", return_value=set()):
            code, out, err = self.restart()
        self.assertEqual(code, 0, err)
        self.assertIn("t1", self.terminals())
        self.assertEqual((self.hc_calls("kill"), self.hc_calls("rm")), ([], []))
        self.assertIn("another name", out + err)
        self.assertEqual(self.stored()["hc"]["address"], "t2")

    def test_refused_when_closed_by_a_close_flow(self):
        for status, extra in (("closed", {}), ("closing", {})):
            self.write_entry(status=status, **extra)
            self.refused("closed by a close flow")

    def test_refused_when_pi_still_runs(self):
        live = self.padir / "pi-foreman" / "state" / "live"
        live.mkdir(parents=True)
        (live / "1.json").write_text(json.dumps({"intercomId": CHILD, "pid": os.getpid()}), "utf-8")
        self.refused("still runs")

    def test_refused_when_the_session_lock_is_held(self):
        lock = self.padir / "pi-foreman" / "state" / "panes" / ("%s.lock" % SID)
        lock.parent.mkdir(parents=True)
        lock.write_text("x", "utf-8")
        self.refused("session lock")

    def test_refused_when_the_restart_lock_is_held(self):
        lock = self.padir / "pi-foreman" / "state" / "restart" / ("%s.lock" % CHILD)
        with fsn.FileLock(lock):  # an OS lock held by another open file description
            code, out, err = self.restart()
        self.assertEqual(code, 1)
        self.assertIn("another restart", out + err)
        self.assertEqual(self.hc_calls("run"), [])

    def test_an_old_restart_lock_file_is_no_lock(self):
        lock = self.padir / "pi-foreman" / "state" / "restart" / ("%s.lock" % CHILD)
        lock.parent.mkdir(parents=True)
        lock.write_text("x", "utf-8")
        old = time.time() - 3600
        os.utime(lock, (old, old))
        code, out, err = self.restart()
        self.assertEqual(code, 0, err)

    def test_refused_when_the_cwd_is_missing(self):
        shutil.rmtree(self.proj)
        self.refused("no longer exists")

    def test_refused_for_a_parent_entry_on_another_machine(self):
        self.write_entry(parent="%s@beta" % PARENT_ID)
        self.refused("another machine")

    def test_herdr_backend_prints_the_hand_line(self):
        self.write_entry(backend="herdr", hc=None, pane="p1")
        code, out, err = self.restart()
        self.assertEqual(code, 0, err)
        self.assertEqual(self.hc_calls("run"), [])
        self.assertIn("--session", out)
        self.assertIn("PI_INTERCOM_STABLE_ID=" + CHILD, out)
        self.assertEqual(self.stored()["status"], "open")

    def test_prune_closed_entry_is_restartable_and_open_again(self):
        self.write_entry(status="closed", note=fsn.PRUNE_NOTE, closedBy="prune")
        code, out, err = self.restart()
        self.assertEqual(code, 0, err)
        stored = self.stored()
        self.assertEqual(stored["status"], "open")
        self.assertNotIn("closedBy", stored)

    def test_entry_pruned_before_the_change_is_restartable(self):
        self.entry.pop("closedBy", None)
        self.write_entry(status="closed", note=fsn.PRUNE_NOTE)
        code, out, err = self.restart()
        self.assertEqual(code, 0, err)
        self.assertEqual(self.stored()["status"], "open")

    def test_dry_run_changes_nothing(self):
        code, out, err = self.restart("demo", "--dry-run")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.hc_calls("run"), [])
        self.assertIn("t1", self.terminals())
        self.assertEqual(self.stored()["hc"]["address"], "t1")


class RestartRemoteTest(LocalRestartBase):
    """The parent's entry for a child on beta; the fake hc runs the remote verb against the remote agent dir."""

    def setUp(self):
        super().setUp()
        self.write_config({"alpha": {"parentName": "beta"}, "beta": {}, "gamma": {}})
        self.env["HC_TERMINAL_ID"] = "t0"
        code, out, err = self.run_main(*self.open_args(machine="alpha"))
        self.assertEqual(code, 0, err)
        self.entry = self.parent_registry()[0]
        self.rhand = Path(self.entry["remoteHandoff"])
        (self.rhand / "live.json").write_text(json.dumps({"piSessionId": SID}), "utf-8")
        self.hc_before = self.entry["hc"]["address"]
        self.hc_old_attach = (self.entry.get("attach") or {}).get("address")

    def test_restart_updates_the_address_and_replaces_the_attach(self):
        code, out, err = self.restart("demo@alpha")
        self.assertEqual(code, 0, err)
        stored = self.parent_registry()[0]
        self.assertEqual(stored["status"], "open")
        self.assertNotEqual(stored["hc"]["address"], self.hc_before)
        self.assertTrue(stored["hc"]["address"].startswith("alpha/"))
        self.assertNotEqual((stored.get("attach") or {}).get("address"), self.hc_old_attach)
        if self.hc_old_attach:
            self.assertIn(self.hc_old_attach, [c[1] for c in self.hc_calls("kill")])
        verbs = [json.loads(r["stdin"]) for r in self.exec_calls()]
        self.assertTrue(any("restart" in r["argv"] for r in self.exec_calls()), verbs)

    def test_older_remote_without_the_verb_is_refused_with_update(self):
        code, out, err = self.restart("demo@alpha", FAKE_REMOTE_VERBS=json.dumps(["probe", "open", "deliver", "close"]))
        self.assertEqual(code, 1)
        self.assertIn("update pi-foreman on alpha", out + err)
        self.assertFalse(any("restart" in r["argv"] for r in self.exec_calls()))

    def test_wrong_parent_is_refused(self):
        runs = len(self.hc_calls("run"))
        code, reply = self.remote("restart", {"handoffName": self.rhand.name, "parentAddress": "%s@beta" % "00000000-0000-0000-0000-000000000000"})
        self.assertEqual((code, reply["code"]), (1, "wrong_session"))
        self.assertEqual(len(self.hc_calls("run")), runs)
