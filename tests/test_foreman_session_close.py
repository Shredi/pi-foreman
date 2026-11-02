"""Remote close and the rest of PR 2 (scripts/foreman_session.py, foreman_radar.py, the Herdr sidebar, foreman_config.py):
the remote `close` verb, `close-remote` over hc, option forwarding, the `cmd_brief` order, the radar and sidebar rows of
remote entries and the `$` anchor of the config validator.

Same fakes as test_foreman_session_remote.py (fake hc, herdr-app and node).
"""
from __future__ import annotations

import datetime
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))
import test_foreman_session_remote as rt  # noqa: E402  (a module reference: its test classes are not re-collected here)
import test_herdr_sidebar as ts  # noqa: E402

fsn, fc = rt.fsn, rt.fc
import foreman_radar as fr  # noqa: E402
import sidebar  # noqa: E402

PARENT, ADDRESS, OTHER = rt.PARENT, rt.ADDRESS, rt.OTHER
lines_of = rt.lines_of


class CloseBase(rt.RemoteBase):
    def setUp(self):
        super().setUp()
        self.entry, self.rh = self.opened()

    def close_params(self, **over):
        p = {"handoffName": self.entry["handoffName"], "parentAddress": ADDRESS}
        p.update(over)
        return p

    def registry_row(self):
        return self.parent_registry()[0]


class CloseVerbTest(CloseBase):
    def test_file_written_and_child_woken(self):
        code, r = self.remote("close", self.close_params())
        self.assertEqual((code, r), (0, {"ok": True, "woke": True}))
        order = json.loads((self.rh / "close.json").read_text("utf-8"))
        self.assertEqual(sorted(order), ["at", "parent", "v"])
        self.assertEqual((order["v"], order["parent"]), (1, ADDRESS))
        age = datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(order["at"])
        self.assertLess(abs(age.total_seconds()), 60)
        (sent,) = lines_of(self.logs["node"])
        self.assertEqual(sent["argv"][1:], ["send", "--to", self.entry["child"], "--text", "foreman:close"])
        self.assertEqual([p.name for p in self.rh.iterdir() if p.name.startswith(".close-")], [])

    def test_path_is_kept_in_the_file_only(self):
        code, r = self.remote("close", self.close_params(path=".workflow/result.md"))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads((self.rh / "close.json").read_text("utf-8"))["path"], ".workflow/result.md")
        self.assertEqual(lines_of(self.logs["node"])[0]["argv"][-1], "foreman:close")

    def test_wrong_session_writes_nothing(self):
        code, r = self.remote("close", self.close_params(parentAddress=OTHER + "@beta"))
        self.assertEqual((code, r["code"]), (1, "wrong_session"))
        self.assertFalse((self.rh / "close.json").exists())
        self.assertEqual(lines_of(self.logs["node"]), [])

    def test_bad_path_and_bad_fields(self):
        for path in ("a b.md", "x.txt", ";.md", "x" * 200 + ".md", ""):
            code, r = self.remote("close", self.close_params(path=path))
            self.assertEqual((code, r["code"]), (1, "bad_request"), path)
        self.assertEqual(self.remote("close", self.close_params(path=5))[1]["code"], "bad_request")
        self.assertEqual(self.remote("close", self.close_params(extra=1))[1]["code"], "bad_request")
        self.assertEqual(self.remote("close", {"handoffName": self.entry["handoffName"]})[1]["code"], "bad_request")
        self.assertEqual(self.remote("close", self.close_params(parentAddress="nope"))[1]["code"], "bad_request")
        self.assertEqual(self.remote("close", self.close_params(handoffName="../x"))[1]["code"], "bad_request")
        self.assertFalse((self.rh / "close.json").exists())

    def test_no_handoff(self):
        code, r = self.remote("close", self.close_params(handoffName="20260101-000000-nothing"))
        self.assertEqual((code, r["code"]), (1, "no_handoff"))

    def test_an_unreachable_broker_still_leaves_the_order(self):
        code, r = self.remote("close", self.close_params(), FAKE_NODE_EXIT="1")
        self.assertEqual((code, r), (0, {"ok": True, "woke": False}))
        self.assertTrue((self.rh / "close.json").is_file())


class CloseRemoteCommandTest(CloseBase):
    def close(self, *args, **env):
        return self.run_main("close-remote", *args, **env)

    def test_success_over_hc(self):
        before = len(self.exec_calls())
        rc, out, err = self.close("demo", "--json")
        self.assertEqual(rc, 0, err)
        self.assertEqual(json.loads(out), {"ok": True, "woke": True})
        call = self.exec_calls()[before]
        self.assertEqual(call["argv"], ["foreman", "session", "remote", "close", "--json"])
        self.assertEqual(json.loads(call["stdin"]), self.close_params())
        exec_argv = self.hc_calls("exec")[-1]
        self.assertEqual(exec_argv[:8], ["exec", "--on", "alpha", "--timeout", "20", "-i", "--json", "--"])
        row = self.registry_row()
        self.assertEqual((row["status"], row["lastError"]), ("closing", None))
        self.assertRegex(row["closeSentAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$")
        self.assertTrue((self.rh / "close.json").is_file())

    def test_by_child_id_and_with_a_path(self):
        rc, out, err = self.close(self.entry["child"], "--path", ".workflow/r.md")
        self.assertEqual(rc, 0, err)
        self.assertEqual(json.loads(self.exec_calls()[-1]["stdin"])["path"], ".workflow/r.md")
        self.assertEqual(json.loads((self.rh / "close.json").read_text("utf-8"))["path"], ".workflow/r.md")

    def test_timeout_constant(self):
        self.assertEqual(fsn.CLOSE_TIMEOUT, 20)

    def test_not_remote(self):
        reg = fsn.read_registry(self.padir)
        reg["sessions"].append({"label": "local", "child": "fm-local-1", "status": "open", "handoff": "/h"})
        fsn.write_registry(self.padir, reg)
        calls = len(self.exec_calls())
        rc, out, err = self.close("local")
        self.assertEqual(rc, 1)
        self.assertIn("[not_remote]", err)
        self.assertEqual(len(self.exec_calls()), calls)

    def test_not_open(self):
        self.assertEqual(self.close("demo")[0], 0)  # closing now
        calls = len(self.exec_calls())
        for status in ("closing", "closed", "failed"):
            reg = fsn.read_registry(self.padir)
            reg["sessions"][0]["status"] = status
            fsn.write_registry(self.padir, reg)
            rc, out, err = self.close("demo")
            self.assertEqual(rc, 1, status)
            self.assertIn("[not_open]", err)
        self.assertEqual(len(self.exec_calls()), calls)

    def test_pending_may_be_closed(self):
        reg = fsn.read_registry(self.padir)
        reg["sessions"][0]["status"] = "pending"
        fsn.write_registry(self.padir, reg)
        self.assertEqual(self.close("demo")[0], 0)
        self.assertEqual(self.registry_row()["status"], "closing")

    def test_unknown_target(self):
        rc, out, err = self.close("nope")
        self.assertEqual(rc, 1)
        self.assertIn("no session", err)

    def test_an_hc_failure_is_recorded(self):
        rc, out, err = self.close("demo", FAKE_HC_EXEC_MODE="timed_out")
        self.assertEqual(rc, 1)
        row = self.registry_row()
        self.assertEqual(row["status"], "open")
        self.assertIn("unreachable", row["lastError"])
        self.assertNotIn("closeSentAt", row)
        self.assertIn("not sent", err)

    def test_a_machine_gone_from_hc_is_recorded(self):
        calls = len(self.exec_calls())
        rc, out, err = self.close("demo", FAKE_HC_MACHINES=json.dumps(["beta"]))
        self.assertEqual(rc, 1)
        self.assertTrue(self.registry_row()["lastError"].startswith("[machine_unknown]"), self.registry_row()["lastError"])
        self.assertEqual(len(self.exec_calls()), calls)

    def test_no_hc_is_recorded_as_hc_missing(self):
        rc, out, err = self.close("demo", PATH=self.path(hc=False))
        self.assertEqual(rc, 1)
        self.assertTrue(self.registry_row()["lastError"].startswith("[hc_missing]"), self.registry_row()["lastError"])

    def test_a_remote_refusal_is_recorded_with_its_code(self):
        reg = fsn.read_registry(self.padir)
        reg["sessions"][0]["handoffName"] = "20260101-000000-nothing"
        fsn.write_registry(self.padir, reg)
        rc, out, err = self.close("demo")
        self.assertEqual(rc, 1)
        row = self.registry_row()
        self.assertEqual(row["status"], "open")
        self.assertTrue(row["lastError"].startswith("[no_handoff]"), row["lastError"])

    def test_bad_path_is_refused_before_hc(self):
        calls = len(self.exec_calls())
        for path in ("x.txt", "a b.md", "a;b.md", "x" * 200 + ".md"):
            rc, out, err = self.close("demo", "--path", path)
            self.assertEqual(rc, 1, path)
            self.assertIn("--path", err)
        self.assertEqual(len(self.exec_calls()), calls)
        self.assertEqual(self.registry_row()["status"], "open")


class ForwardingTest(rt.RemoteBase):
    def open_payload(self):
        return json.loads(self.exec_calls()[1]["stdin"])

    def test_options_are_sent_only_when_set(self):
        self.assertEqual(self.run_main(*self.open_args())[0], 0)
        sent = self.open_payload()
        self.assertNotIn("firstCommands", sent)
        self.assertNotIn("focus", sent)

    def test_plan_mode_and_first_command_reach_the_remote(self):
        rc, out, err = self.run_main(*self.open_args("--plan-mode", "--first-command", "/review"))
        self.assertEqual(rc, 0, err)
        sent = self.open_payload()
        self.assertEqual(sent["firstCommands"], ["/plan", "/review"])
        self.assertNotIn("focus", sent)
        entry = self.remote_registry()[0]
        self.assertEqual(entry["firstCommands"], ["/plan", "/review"])
        launch = (Path(self.parent_registry()[0]["remoteHandoff"]) / "launch.txt").read_text("utf-8")
        self.assertIn("/plan Read the handoff", launch)
        self.assertIn("/review", launch)

    def test_focus_is_done_locally_through_herdr_app(self):
        rc, out, err = self.run_main(*self.open_args("--focus"))
        self.assertEqual(rc, 0, err)
        self.assertNotIn("focus", self.open_payload())
        focus = [c for c in lines_of(self.logs["app"]) if c[:2] == ["do", "agent.focus"]]
        self.assertEqual([json.loads(c[2]) for c in focus], [{"terminal": "alpha/t1"}])

    def test_no_focus_without_the_flag(self):
        self.assertEqual(self.run_main(*self.open_args())[0], 0)
        self.assertEqual([c for c in lines_of(self.logs["app"]) if c[:2] == ["do", "agent.focus"]], [])

    def test_only_the_options_that_are_set_are_sent(self):
        self.assertEqual(self.run_main(*self.open_args("--first-command", "/x"))[0], 0)
        self.assertEqual(self.open_payload()["firstCommands"], ["/x"])

    def test_the_remote_validates_first_commands(self):
        for bad in (["nolslash"], ["/a"] * 1 + ["/b", "/c", "/d", "/e"], ["/x\ny"], [5], ["/" + "a" * 200]):
            code, r = self.remote("open", self.open_params(firstCommands=bad))
            self.assertEqual((code, r["code"]), (1, "bad_request"), bad)
        code, r = self.remote("open", self.open_params(firstCommands="/x"))
        self.assertEqual((code, r["code"]), (1, "bad_request"))
        code, r = self.remote("open", self.open_params(focus="yes"))
        self.assertEqual((code, r["code"]), (1, "bad_request"))
        self.assertEqual(self.remote_registry(), [])

    def test_a_bad_first_command_is_refused_before_hc(self):
        rc, out, err = self.run_main(*self.open_args("--first-command", "nolslash"))
        self.assertEqual(rc, 1)
        self.assertIn("--first-command must start with /", err)
        self.assertEqual(self.hc_calls("machine", "exec"), [])

    def test_print_all_keeps_its_refusal(self):
        rc, out, err = self.run_main(*self.open_args("--print-all", "--plan-mode"))
        self.assertEqual(rc, 1)
        self.assertIn("[remote_option]", err)
        self.assertIn("--print-all is not supported with --machine in this version", err)
        self.assertEqual(self.hc_calls("machine", "exec"), [])

    def test_a_malformed_probe_hc_field_is_unreachable(self):
        probe = {"protocol": fsn.REMOTE_PROTOCOL, "piVersion": "pi 9", "intercomMachineName": "alpha"}
        for bad in (5, None, ["x"]):
            with mock.patch.object(fsn, "hc_exec_verb", side_effect=lambda *a, **k: dict(probe, hc=bad)):
                rc, out, err = self.run_main(*self.open_args())
            self.assertEqual(rc, 1, bad)
            self.assertIn("probe reply is malformed", err)
            self.assertNotIn("Traceback", err)
        self.assertEqual(self.parent_registry(), [])

    def test_a_differing_intercom_name_is_a_warning(self):
        rc, out, err = self.run_main(*self.open_args())
        self.assertEqual(rc, 0, err)
        self.assertIn("warning: intercom name differs: ", out)


class ResolveOrderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="session_close_")).resolve()
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.adir = self.tmp / "agent"
        self.cwd = self.tmp / "cwd"
        (self.cwd / "demo").mkdir(parents=True)
        (self.cwd / "demo" / "child").write_text("fm-dir-1\n", "utf-8")
        self.old = os.getcwd()
        os.chdir(str(self.cwd))
        self.addCleanup(os.chdir, self.old)

    def register(self):
        fsn.write_registry(self.adir, {"version": 1, "sessions": [
            {"label": "demo", "child": "fm-reg-1", "status": "open", "handoff": str(self.tmp / "h")}]})

    def test_the_registry_wins_over_a_directory_of_the_same_name(self):
        self.register()
        self.assertEqual(fsn.resolve_child(self.adir, "demo"), ("fm-reg-1", self.tmp / "h"))

    def test_a_directory_is_a_handoff_dir_when_no_entry_matched(self):
        self.register()
        self.assertEqual(fsn.resolve_child(self.adir, "demo/")[0], "fm-dir-1")
        self.assertEqual(fsn.resolve_child(self.adir, str(self.cwd / "demo")), ("fm-dir-1", self.cwd / "demo"))

    def test_neither_is_refused(self):
        self.register()
        with self.assertRaises(fsn.Refused):
            fsn.resolve_child(self.adir, "other")


class BriefOrderTest(rt.RemoteBase):
    def test_a_registry_label_beats_a_directory_for_a_remote_entry(self):
        entry, rh = self.opened()
        (Path(os.getcwd()) / "demo").mkdir(exist_ok=True)
        self.addCleanup(shutil.rmtree, str(Path(os.getcwd()) / "demo"), True)
        rc, out, err = self.run_main("brief", "demo", "hello")
        self.assertEqual(rc, 0, err)
        self.assertEqual(json.loads(self.exec_calls()[-1]["stdin"])["content"], "hello")


class ValidatorAnchorTest(unittest.TestCase):
    def issues(self, value, pattern="^[a-z]+$"):
        out = []
        fc.validate_schema(value, {"type": "string", "pattern": pattern}, "x", out)
        return out

    def test_a_trailing_newline_does_not_match_a_dollar_anchored_pattern(self):
        self.assertEqual(self.issues("alpha"), [])
        self.assertEqual(len(self.issues("alpha\n")), 1)

    def test_an_escaped_dollar_is_left_alone(self):
        self.assertEqual(self.issues("a$", r"^a\$"), [])
        self.assertEqual(self.issues("a$\n", r"^a\$"), [])  # unanchored at the end: still a search match
        self.assertEqual(self.issues("a\\", r"^a\\$"), [])
        self.assertEqual(len(self.issues("a\\\n", r"^a\\$")), 1)

    def test_a_machine_setting_ending_in_a_newline_is_refused_by_the_schema(self):
        schema = json.loads((Path(fc.__file__).resolve().parent.parent / "config" / "foreman.schema.json").read_text("utf-8"))
        for key in ("space", "parentName"):
            out = []
            fc.validate_schema({"sessions": {"machines": {"alpha": {key: "valid"}}}}, schema, "", out)
            self.assertEqual(out, [], key)
            fc.validate_schema({"sessions": {"machines": {"alpha": {key: "valid\n"}}}}, schema, "", out)
            self.assertEqual(len(out), 1, key)
        out = []
        fc.validate_schema({"sessions": {"machines": {"alpha": {"foremanArgv": ["foreman\n"]}}}}, schema, "", out)
        self.assertEqual(len(out), 1)


NOW = datetime.datetime(2026, 10, 26, 12, 0, 0, tzinfo=datetime.timezone.utc).timestamp()


def iso(ago):
    return datetime.datetime.fromtimestamp(NOW - ago, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def local_iso(ago):
    return datetime.datetime.fromtimestamp(NOW - ago).strftime("%Y-%m-%dT%H:%M:%S")


def remote_entry(**over):
    e = {"label": "demo", "child": "fm-demo-1", "parent": "fm-top", "parentAddress": "fm-top@beta", "status": "open",
         "opened": local_iso(30), "last": None, "handoff": "/mirror/20261026-110000-demo", "machine": "alpha"}
    e.update(over)
    return e


def build(entry, parent=True):
    live = []
    if parent:
        live.append({"sessionId": "s-top", "intercomId": "fm-top", "label": "top", "cwd": "/work/x", "pid": 1,
                     "startedAt": iso(3600), "heartbeatAt": iso(5), "lastEventAt": iso(12), "state": "working",
                     "runs": [], "handoff": None})
    data = {"live": live, "registry": [entry], "handoffs": {}, "usage": {}, "trace": {}}
    roots = fr.build(data, NOW)
    return roots[0] if len(roots) == 1 else roots


class RadarRemoteTest(unittest.TestCase):
    def kid(self, entry, **kw):
        top = build(entry, **kw)
        (kid,) = top["children"]
        return kid

    def test_name_and_machine(self):
        k = self.kid(remote_entry())
        self.assertEqual((k["name"], k["machine"], k["glyph"], k["state"]), ("demo@alpha", "alpha", "starting", "starting"))
        doc = fr.to_json_node(k, NOW, fr.load_symbols())
        self.assertEqual(doc["machine"], "alpha")
        self.assertNotIn("pulled_s", doc)

    def test_the_glyph_follows_the_registry_status_only(self):
        k = self.kid(remote_entry(opened=local_iso(1000)))
        self.assertEqual((k["glyph"], k["state"]), ("lost", "lost"))  # open, nothing reaches this machine, window over
        k = self.kid(remote_entry(status="pending", opened=local_iso(1000)))
        self.assertEqual((k["glyph"], k["state"]), ("starting", "pending"))
        for stale in ({"pulledAt": iso(10)}, {"remoteLive": {"state": "working", "heartbeatAgeSeconds": 1}}):
            k = self.kid(remote_entry(opened=local_iso(1000), **stale))
            self.assertEqual((k["glyph"], k["state"]), ("lost", "lost"), stale)  # the removed pull fields change nothing

    def test_an_open_ask_shows_the_asking_glyph(self):
        k = self.kid(remote_entry(ask={"n": 1, "topic": "which db"}, opened=local_iso(1000)))
        self.assertEqual((k["glyph"], k["state"], fr.sym_key(k)), ("blocked", "ask", "asking"))

    def test_closing_and_closed(self):
        for status in ("closing", "closed"):
            k = self.kid(remote_entry(status=status, ask={"n": 1, "topic": "t"}))
            self.assertEqual((k["glyph"], k["state"]), ("idle", status), status)

    def test_a_local_entry_is_unchanged(self):
        k = self.kid(remote_entry(machine=None))
        self.assertEqual((k["name"], k["glyph"], k.get("machine")), ("demo", "starting", None))
        self.assertNotIn("machine", fr.to_json_node(k, NOW, fr.load_symbols()))

    def test_the_pull_interval_helper_is_gone(self):
        self.assertFalse(hasattr(fr, "config_pull_interval"))
        self.assertFalse(hasattr(fr, "PULL_INTERVAL"))
        self.assertNotIn("pullInterval", fr.load(Path(tempfile.mkdtemp(prefix="radar_cfg_"))))


class SidebarRemoteTest(unittest.TestCase):
    def a1(self, entry):
        roots = [r for r in [build(entry)] if fr.finish(r, NOW, 24.0)]
        snap = fr.json_doc(roots, NOW, "unicode", fr.load_symbols(), 8)
        a1 = sidebar.compose(snap, 60, {"fm-top": "w1:p1"})["w1:p1"]["fm_a1"]
        return (a1 or "").replace(sidebar.BLANK, " ").strip()

    def test_the_child_row_names_machine_and_state(self):
        text = self.a1(remote_entry(last={"kind": "update", "at": iso(300)}))
        self.assertIn("demo@alpha \u00b7 starting \u00b7 ", text)

    def test_an_ask_shows_in_the_row(self):
        self.assertIn("demo@alpha \u00b7 ask \u00b7 ", self.a1(remote_entry(ask={"n": 2, "topic": "t"})))

    def test_closing_closed_and_lost_children_have_no_row(self):
        for over in ({"status": "closing"}, {"status": "closed"}, {"opened": local_iso(1000)}):
            self.assertEqual(self.a1(remote_entry(**over)), "", over)

    def test_the_snapshot_node_carries_the_machine(self):
        node = ts.node("k", "session", "demo@alpha", "working", "working", ts.SYMS["unicode"], age=65)
        top = ts.node("t", "session", "top", "working", "working", ts.SYMS["unicode"], pane="w1:p1",
                      children=[dict(node, machine="alpha")])
        text = sidebar.compose({"roots": [top]}, 60)["w1:p1"]["fm_a1"].replace(sidebar.BLANK, " ").strip()
        self.assertIn("demo@alpha \u00b7 working \u00b7 1m", text)
        local = sidebar.compose({"roots": [dict(top, children=[node])]}, 60)["w1:p1"]["fm_a1"].replace(sidebar.BLANK, " ").strip()
        self.assertNotIn("\u00b7 working", local)


if __name__ == "__main__":
    unittest.main()
