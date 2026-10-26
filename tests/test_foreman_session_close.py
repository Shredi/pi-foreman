"""Remote close and the rest of PR 2 (scripts/foreman_session.py, foreman_radar.py, the Herdr sidebar, foreman_config.py):
the remote `close` verb, `close-remote`, option forwarding, the pi-intercom PATH warning, the `cmd_brief` order, the
radar and sidebar rows of remote entries and the `$` anchor of the config validator.

Same fakes as test_foreman_session_remote.py. Tests that need a fake binary are `posix_only`; the pure-Python ones are not.
"""
from __future__ import annotations

import datetime
import json
import os
import shlex
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
posix_only, lines_of = rt.posix_only, rt.lines_of
RELAY = "pi-intercom-does-not-exist-9f3a"


class CloseBase(rt.RemoteBase):
    def setUp(self):
        super().setUp()
        self.entry, self.rh = self.opened()

    def ssh_calls(self):
        return lines_of(self.logs["ssh"])

    def close_params(self, **over):
        p = {"handoffName": self.entry["handoffName"], "parentAddress": ADDRESS}
        p.update(over)
        return p

    def registry_row(self):
        return self.parent_registry()[0]


@posix_only
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


@posix_only
class CloseRemoteCommandTest(CloseBase):
    def close(self, *args, **env):
        return self.run_main("close-remote", *args, **env)

    def test_success(self):
        before = len(self.ssh_calls())
        rc, out, err = self.close("demo", "--json")
        self.assertEqual(rc, 0, err)
        self.assertEqual(json.loads(out), {"ok": True, "woke": True})
        call = self.ssh_calls()[before]
        self.assertEqual(call["argv"][-1], "foreman session remote close --json")
        self.assertEqual(json.loads(call["stdin"]), self.close_params())
        row = self.registry_row()
        self.assertEqual((row["status"], row["lastError"]), ("closing", None))
        self.assertRegex(row["closeSentAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$")
        self.assertTrue((self.rh / "close.json").is_file())

    def test_by_child_id_and_with_a_path(self):
        rc, out, err = self.close(self.entry["child"], "--path", ".workflow/r.md")
        self.assertEqual(rc, 0, err)
        self.assertEqual(json.loads(self.ssh_calls()[-1]["stdin"])["path"], ".workflow/r.md")
        self.assertEqual(json.loads((self.rh / "close.json").read_text("utf-8"))["path"], ".workflow/r.md")

    def test_timeout_constant(self):
        self.assertEqual(fsn.CLOSE_TIMEOUT, 30)
        seen = []
        real = fsn.subprocess.run

        def spy(argv, **kw):
            if argv and Path(argv[0]).name == "ssh":
                seen.append(kw.get("timeout"))
            return real(argv, **kw)

        with mock.patch.object(fsn.subprocess, "run", side_effect=spy):
            self.assertEqual(self.close("demo")[0], 0)
        self.assertEqual(seen, [30])

    def test_not_remote(self):
        reg = fsn.read_registry(self.padir)
        reg["sessions"].append({"label": "local", "child": "fm-local-1", "status": "open", "handoff": "/h"})
        fsn.write_registry(self.padir, reg)
        calls = len(self.ssh_calls())
        rc, out, err = self.close("local")
        self.assertEqual(rc, 1)
        self.assertIn("[not_remote]", err)
        self.assertEqual(len(self.ssh_calls()), calls)

    def test_not_open(self):
        self.assertEqual(self.close("demo")[0], 0)  # closing now
        calls = len(self.ssh_calls())
        for status in ("closing", "closed", "failed"):
            reg = fsn.read_registry(self.padir)
            reg["sessions"][0]["status"] = status
            fsn.write_registry(self.padir, reg)
            rc, out, err = self.close("demo")
            self.assertEqual(rc, 1, status)
            self.assertIn("[not_open]", err)
        self.assertEqual(len(self.ssh_calls()), calls)

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

    def test_ssh_failure_is_recorded(self):
        rc, out, err = self.close("demo", FAKE_SSH_MODE="255")
        self.assertEqual(rc, 1)
        row = self.registry_row()
        self.assertEqual(row["status"], "open")
        self.assertIn("unreachable", row["lastError"])
        self.assertNotIn("closeSentAt", row)
        self.assertIn("not sent", err)

    def test_a_remote_refusal_is_recorded_with_its_code(self):
        reg = fsn.read_registry(self.padir)
        reg["sessions"][0]["handoffName"] = "20260101-000000-nothing"
        fsn.write_registry(self.padir, reg)
        rc, out, err = self.close("demo")
        self.assertEqual(rc, 1)
        row = self.registry_row()
        self.assertEqual(row["status"], "open")
        self.assertTrue(row["lastError"].startswith("[no_handoff]"), row["lastError"])

    def test_bad_path_is_refused_before_ssh(self):
        calls = len(self.ssh_calls())
        for path in ("x.txt", "a b.md", "a;b.md", "x" * 200 + ".md"):
            rc, out, err = self.close("demo", "--path", path)
            self.assertEqual(rc, 1, path)
            self.assertIn("--path", err)
        self.assertEqual(len(self.ssh_calls()), calls)
        self.assertEqual(self.registry_row()["status"], "open")


@posix_only
class ForwardingTest(rt.RemoteBase):
    def open_payload(self):
        return json.loads(lines_of(self.logs["ssh"])[1]["stdin"])

    def test_options_are_sent_only_when_set(self):
        self.assertEqual(self.run_main(*self.open_args())[0], 0)
        sent = self.open_payload()
        self.assertNotIn("firstCommands", sent)
        self.assertNotIn("focus", sent)

    def test_plan_mode_first_command_and_focus_reach_the_remote(self):
        rc, out, err = self.run_main(*self.open_args("--plan-mode", "--first-command", "/review", "--focus"))
        self.assertEqual(rc, 0, err)
        sent = self.open_payload()
        self.assertEqual((sent["firstCommands"], sent["focus"]), (["/plan", "/review"], True))
        entry = self.remote_registry()[0]
        self.assertEqual(entry["firstCommands"], ["/plan", "/review"])
        launch = (Path(self.parent_registry()[0]["remoteHandoff"]) / "launch.txt").read_text("utf-8")
        self.assertIn("/plan", launch)
        self.assertIn("/review", launch)
        self.assertTrue(any(l[:2] == ["tab", "focus"] for l in lines_of(self.logs["herdr"])))

    def test_only_the_options_that_are_set_are_sent(self):
        self.assertEqual(self.run_main(*self.open_args("--first-command", "/x"))[0], 0)
        sent = self.open_payload()
        self.assertEqual(sent["firstCommands"], ["/x"])
        self.assertNotIn("focus", sent)

    def test_the_remote_validates_first_commands(self):
        for bad in (["nolslash"], ["/a"] * 1 + ["/b", "/c", "/d", "/e"], ["/x\ny"], [5], ["/" + "a" * 200]):
            code, r = self.remote("open", self.open_params(firstCommands=bad))
            self.assertEqual((code, r["code"]), (1, "bad_request"), bad)
        code, r = self.remote("open", self.open_params(firstCommands="/x"))
        self.assertEqual((code, r["code"]), (1, "bad_request"))
        code, r = self.remote("open", self.open_params(focus="yes"))
        self.assertEqual((code, r["code"]), (1, "bad_request"))
        self.assertEqual(self.remote_registry(), [])

    def test_a_bad_first_command_is_refused_before_ssh(self):
        rc, out, err = self.run_main(*self.open_args("--first-command", "nolslash"))
        self.assertEqual(rc, 1)
        self.assertIn("--first-command must start with /", err)
        self.assertEqual(lines_of(self.logs["ssh"]), [])

    def test_print_all_keeps_its_refusal(self):
        rc, out, err = self.run_main(*self.open_args("--print-all", "--plan-mode"))
        self.assertEqual(rc, 1)
        self.assertIn("[remote_option]", err)
        self.assertIn("--print-all is not supported with --machine in this version", err)
        self.assertEqual(lines_of(self.logs["ssh"]), [])

    def test_a_pull_open_carries_the_options_too(self):
        self.write_config({"alpha": {"parentName": "beta", "returnPath": "pull"}})
        rc, out, err = self.run_main(*self.open_args("--plan-mode", parent="fm-stable-id"), HERDR_PANE_ID="")
        self.assertEqual(rc, 0, err)
        sent = self.open_payload()
        self.assertEqual((sent["returnPath"], sent["firstCommands"]), ("pull", ["/plan"]))


class RelayWarningTest(unittest.TestCase):
    def warn(self, relay, cli="/opt/pi/cli.mjs", node="/usr/local/bin/node"):
        with mock.patch.object(fsn, "intercom_cli", return_value=Path(cli) if cli else None), \
                mock.patch.object(fsn.shutil, "which", side_effect=lambda n, *a, **k: node if n == "node" and node else None):
            return fsn.relay_warning("alpha", relay)

    def test_a_relative_command_off_path_names_the_fix(self):
        text = self.warn(RELAY)
        self.assertIn("crossMachine.remoteCommand", text)
        self.assertIn("/usr/local/bin/node /opt/pi/cli.mjs", text)
        self.assertNotIn(RELAY, text)

    def test_the_two_paths_are_shell_quoted(self):
        text = self.warn(RELAY, cli="/opt/my pi/cli.mjs", node="/usr/local/b in/node")
        self.assertIn("%s %s" % (shlex.quote("/usr/local/b in/node"), shlex.quote("/opt/my pi/cli.mjs")), text)

    def test_the_fallback_text_when_the_paths_are_not_found(self):
        for cli, node in ((None, "/usr/local/bin/node"), ("/opt/pi/cli.mjs", None), (None, None)):
            text = self.warn(RELAY, cli=cli, node=node)
            self.assertIn("not found on PATH", text, (cli, node))
            self.assertIn("docs/sessions.md", text)
            self.assertNotIn("remoteCommand", text)
            self.assertNotIn(RELAY, text)

    def test_empty_and_unparsable_values_give_the_fallback(self):
        for relay in ("", "   ", 'say "unbalanced', "it's"):
            text = self.warn(relay)
            self.assertIn("docs/sessions.md", text, relay)
            self.assertNotIn("unbalanced", text)

    def test_an_absolute_command_or_one_on_path_gives_none(self):
        self.assertIsNone(self.warn(os.path.abspath(os.sep + os.path.join("opt", "pi", "pi-intercom"))))
        with mock.patch.object(fsn.shutil, "which", return_value="/usr/bin/pi-intercom"):
            self.assertIsNone(fsn.relay_warning("alpha", "pi-intercom --flag"))

    def test_the_first_shell_word_is_tested(self):
        self.assertIn("remoteCommand", self.warn("%s --flag 'a b'" % RELAY))
        self.assertIn("remoteCommand", self.warn("'%s' --flag" % RELAY))


@posix_only
class RelayWarningOpenTest(rt.RemoteBase):
    PROBE = {"protocol": 2, "piVersion": "pi 9", "intercomVersion": "1", "returnPathOk": True, "returnPath": "push",
             "intercomMachine": "alpha"}

    def open_with_relay(self, relay, **extra):
        probe = dict(self.PROBE, **extra)
        if relay is not None:
            probe["relayCommand"] = relay

        def fake(name, target, command, verb, payload, timeout):
            if verb == "probe":
                return probe
            raise fsn.Unreachable("remote %s unreachable: stop here" % name)

        with mock.patch.object(fsn, "ssh_verb", side_effect=fake):
            return self.run_main(*self.open_args())

    def test_the_open_proceeds_with_one_warning(self):
        rc, out, err = self.open_with_relay(RELAY + " --secret-flag")
        self.assertEqual(err.count("crossMachine.remoteCommand"), 1)
        self.assertEqual(err.count("stop here"), 1)  # it went on to the open verb
        self.assertNotIn(RELAY, err)
        self.assertNotIn("secret-flag", err)
        self.assertIn(shlex.quote(str(self.cli)), err)

    def test_empty_and_unparsable_values_do_not_raise(self):
        for relay in ("", 'a "b'):
            rc, out, err = self.open_with_relay(relay)
            self.assertIn("docs/sessions.md", err, relay)
            self.assertIn("stop here", err)
            self.assertNotIn("Traceback", err)

    def test_a_non_string_is_a_malformed_probe(self):
        for relay in (5, None, ["pi-intercom"]):
            probe = dict(self.PROBE, relayCommand=relay)
            with mock.patch.object(fsn, "ssh_verb", side_effect=lambda *a, **k: probe):
                rc, out, err = self.run_main(*self.open_args())
            self.assertEqual(rc, 1, relay)
            self.assertIn("probe reply is malformed", err)
            self.assertNotIn("Traceback", err)
        rc, out, err = self.open_with_relay(None)  # a missing field is not a string either
        self.assertIn("probe reply is malformed", err)

    def test_a_command_on_path_or_absolute_warns_nothing(self):
        self.script(self.bin / "pi-relay-present", "pass\n")
        for relay in ("pi-relay-present", "/opt/x/pi-intercom"):
            rc, out, err = self.open_with_relay(relay)
            self.assertNotIn("crossMachine", err, relay)
            self.assertNotIn("docs/sessions.md", err, relay)

    def test_pull_mode_checks_nothing(self):
        self.write_config({"alpha": {"parentName": "beta", "returnPath": "pull"}})
        rc, out, err = self.open_with_relay(RELAY, returnPath="pull")
        self.assertNotIn("crossMachine", err)
        self.assertIn("stop here", err)
        rc, out, err = self.open_with_relay(5, returnPath="pull")
        self.assertNotIn("malformed", err)


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


@posix_only
class BriefOrderTest(rt.RemoteBase):
    def test_a_registry_label_beats_a_directory_for_a_remote_entry(self):
        entry, rh = self.opened()
        (Path(os.getcwd()) / "demo").mkdir(exist_ok=True)
        self.addCleanup(shutil.rmtree, str(Path(os.getcwd()) / "demo"), True)
        rc, out, err = self.run_main("brief", "demo", "hello")
        self.assertEqual(rc, 0, err)
        self.assertEqual(json.loads(lines_of(self.logs["ssh"])[-1]["stdin"])["content"], "hello")


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
        for key in ("foremanCommand", "parentName"):
            out = []
            fc.validate_schema({"sessions": {"machines": {"alpha": {key: "valid"}}}}, schema, "", out)
            self.assertEqual(out, [], key)
            fc.validate_schema({"sessions": {"machines": {"alpha": {key: "valid\n"}}}}, schema, "", out)
            self.assertEqual(len(out), 1, key)


NOW = datetime.datetime(2026, 10, 26, 12, 0, 0, tzinfo=datetime.timezone.utc).timestamp()


def iso(ago):
    return datetime.datetime.fromtimestamp(NOW - ago, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def local_iso(ago):
    return datetime.datetime.fromtimestamp(NOW - ago).strftime("%Y-%m-%dT%H:%M:%S")


def remote_entry(**over):
    e = {"label": "demo", "child": "fm-demo-1", "parent": "fm-top", "parentAddress": "fm-top@beta", "status": "open",
         "opened": local_iso(1000), "last": None, "handoff": "/mirror/20261026-110000-demo", "machine": "alpha",
         "returnPath": "pull", "pulledAt": iso(10),
         "remoteLive": {"state": "working", "heartbeatAgeSeconds": 20}}
    e.update(over)
    return e


def build(entry, interval=20, parent=True):
    live = []
    if parent:
        live.append({"sessionId": "s-top", "intercomId": "fm-top", "label": "top", "cwd": "/work/x", "pid": 1,
                     "startedAt": iso(3600), "heartbeatAt": iso(5), "lastEventAt": iso(12), "state": "working",
                     "runs": [], "handoff": None})
    data = {"live": live, "registry": [entry], "handoffs": {}, "usage": {}, "trace": {}, "pullInterval": interval}
    roots = fr.build(data, NOW)
    return roots[0] if len(roots) == 1 else roots


class RadarRemoteTest(unittest.TestCase):
    def kid(self, entry, **kw):
        top = build(entry, **kw)
        (kid,) = top["children"]
        return kid

    def test_name_machine_and_live_state(self):
        k = self.kid(remote_entry())
        self.assertEqual((k["name"], k["machine"], k["glyph"], k["state"]), ("demo@alpha", "alpha", "working", "working"))
        self.assertEqual(k["last"], NOW - 10)
        doc = fr.to_json_node(k, NOW, fr.load_symbols())
        self.assertEqual((doc["machine"], doc["pulled_s"], doc["age_s"]), ("alpha", 10, 10))

    def test_last_is_the_newest_of_last_and_pulled(self):
        k = self.kid(remote_entry(last={"kind": "update", "at": iso(3)}))
        self.assertEqual(k["last"], NOW - 3)
        k = self.kid(remote_entry(last={"kind": "update", "at": iso(300)}))
        self.assertEqual(k["last"], NOW - 10)

    def test_live_states(self):
        for state, want in (("blocked", ("blocked", "blocked")), ("working", ("working", "working")),
                            ("waiting", ("idle", "idle")), ("idle", ("idle", "idle")), ("done", ("idle", "done"))):
            k = self.kid(remote_entry(remoteLive={"state": state, "heartbeatAgeSeconds": 5}))
            self.assertEqual((k["glyph"], k["state"]), want, state)

    def test_a_stale_pull_is_lost(self):
        k = self.kid(remote_entry(pulledAt=iso(3 * 20 + 30 + 1)))
        self.assertEqual((k["glyph"], k["state"]), ("lost", "lost"))
        k = self.kid(remote_entry(pulledAt=iso(3 * 20 + 29), remoteLive={"state": "working", "heartbeatAgeSeconds": 0}))
        self.assertEqual(k["glyph"], "working")

    def test_the_window_follows_the_pull_interval(self):
        k = self.kid(remote_entry(pulledAt=iso(200)), interval=100)
        self.assertEqual((k["glyph"], k["state"]), ("idle", "idle"))  # fresh pull, heartbeat too old to show

    def test_an_old_heartbeat_does_not_show_the_live_state_but_is_not_lost(self):
        k = self.kid(remote_entry(remoteLive={"state": "working", "heartbeatAgeSeconds": 85}, pulledAt=iso(10)))
        self.assertEqual((k["glyph"], k["state"]), ("idle", "idle"))
        k = self.kid(remote_entry(remoteLive=None))
        self.assertEqual((k["glyph"], k["state"]), ("idle", "idle"))

    def test_malformed_live_data_is_ignored(self):
        for live in ("x", {"state": "working"}, {"state": "working", "heartbeatAgeSeconds": True},
                     {"state": "working", "heartbeatAgeSeconds": "5"}, {"state": "bogus", "heartbeatAgeSeconds": 5}):
            k = self.kid(remote_entry(remoteLive=live))
            self.assertIn(k["glyph"], ("idle", "lost"), live)

    def test_an_open_ask_shows_the_asking_glyph(self):
        k = self.kid(remote_entry(ask={"n": 1, "topic": "which db"}))
        self.assertEqual((k["glyph"], k["state"], fr.sym_key(k)), ("blocked", "ask", "asking"))
        stale = self.kid(remote_entry(ask={"n": 1, "topic": "t"}, pulledAt=iso(500)))
        self.assertEqual(stale["state"], "ask")

    def test_closing_and_closed(self):
        for status in ("closing", "closed"):
            k = self.kid(remote_entry(status=status, ask={"n": 1, "topic": "t"}))
            self.assertEqual((k["glyph"], k["state"]), ("idle", status), status)

    def test_pending_stays_starting_and_a_never_pulled_open_entry_is_lost_after_its_window(self):
        k = self.kid(remote_entry(status="pending", pulledAt=None, remoteLive=None, opened=local_iso(1000)))
        self.assertEqual((k["glyph"], k["state"]), ("starting", "pending"))
        k = self.kid(remote_entry(pulledAt=None, remoteLive=None, opened=local_iso(30)))
        self.assertEqual((k["glyph"], k["state"]), ("starting", "starting"))
        k = self.kid(remote_entry(pulledAt=None, remoteLive=None, opened=local_iso(1000)))
        self.assertEqual((k["glyph"], k["state"]), ("lost", "lost"))

    def test_a_push_entry_keeps_the_p1_glyph(self):
        k = self.kid(remote_entry(returnPath="push", pulledAt=None, remoteLive=None, opened=local_iso(1000)))
        self.assertEqual((k["glyph"], k["name"]), ("lost", "demo@alpha"))
        k = self.kid(remote_entry(returnPath="push", pulledAt=None, remoteLive=None, opened=local_iso(30)))
        self.assertEqual(k["glyph"], "starting")

    def test_a_local_entry_is_unchanged(self):
        k = self.kid(remote_entry(machine=None, returnPath=None, pulledAt=None, remoteLive=None, opened=local_iso(30)))
        self.assertEqual((k["name"], k["glyph"], k.get("machine")), ("demo", "starting", None))
        self.assertNotIn("machine", fr.to_json_node(k, NOW, fr.load_symbols()))

    def test_the_interval_comes_from_the_config(self):
        tmp = Path(tempfile.mkdtemp(prefix="radar_cfg_"))
        self.addCleanup(shutil.rmtree, str(tmp), True)
        self.assertEqual(fr.config_pull_interval(tmp), 20)
        (tmp / "foreman.json").write_text(json.dumps({"sessions": {"pull": {"intervalSeconds": 60}}}), "utf-8")
        self.assertEqual(fr.config_pull_interval(tmp), 60)
        self.assertEqual(fr.load(tmp)["pullInterval"], 60)


class SidebarRemoteTest(unittest.TestCase):
    def a1(self, entry):
        roots = [r for r in [build(entry)] if fr.finish(r, NOW, 24.0)]
        snap = fr.json_doc(roots, NOW, "unicode", fr.load_symbols(), 8)
        a1 = sidebar.compose(snap, 60, {"fm-top": "w1:p1"})["w1:p1"]["fm_a1"]
        return (a1 or "").replace(sidebar.BLANK, " ").strip()

    def test_the_child_row_names_machine_state_and_age(self):
        text = self.a1(remote_entry(last={"kind": "update", "at": iso(300)}, pulledAt=iso(40),
                                    remoteLive={"state": "working", "heartbeatAgeSeconds": 5}))
        self.assertEqual(text.split(" ", 1)[1], "demo@alpha \u00b7 working \u00b7 40s")

    def test_an_ask_shows_in_the_row(self):
        self.assertIn("demo@alpha \u00b7 ask \u00b7 ", self.a1(remote_entry(ask={"n": 2, "topic": "t"})))

    def test_closing_closed_and_lost_children_have_no_row(self):
        for over in ({"status": "closing"}, {"status": "closed"}, {"pulledAt": iso(500)}):
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
