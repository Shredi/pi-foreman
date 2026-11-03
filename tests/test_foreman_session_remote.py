"""Remote child sessions (scripts/foreman_session.py): the config, the remote verbs probe/open/deliver/notice and the parent CLI.

The transport is `hc exec --on <machine>`; the tests run on the fake hc of tests/fakes/hc.py, which runs the remote verb
in-process against a second agent dir. Other fakes: `herdr-app` (spaces) and a `node` for pi-intercom's CLI. Machine names
are alpha, beta and gamma. The fakes install as scripts on POSIX and as .cmd + .py pairs on win32.
"""
from __future__ import annotations

import base64
import contextlib
import hashlib
import io
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

TESTS = Path(__file__).resolve().parent
SCRIPTS = TESTS.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(TESTS))
sys.path.insert(0, str(TESTS / "fakes"))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_config as fc  # noqa: E402
import foreman_session as fsn  # noqa: E402
import foreman_trust  # noqa: E402
from hc_install import install_fake_hc  # noqa: E402

PARENT = "11111111-2222-3333-4444-555555555555"
OTHER = "99999999-8888-7777-6666-555555555555"
ADDRESS = PARENT + "@beta"
HC_MACHINES = ["alpha", "beta", "gamma"]
SPACES = [{"id": "sp-beta", "machine": "beta"}, {"id": "sp-alpha", "machine": "alpha"}]

FAKE_HERDR_APP = r'''
import json, os, sys
args = sys.argv[1:]
with open(os.environ["FAKE_APP_LOG"], "a", encoding="utf-8") as f:
    f.write(json.dumps(args) + "\n")
if args == ["ls"]:
    print(json.dumps({"spaces": json.loads(os.environ.get("FAKE_APP_SPACES", "[]"))}))
elif args[:2] == ["do", "space.new"]:
    if os.environ.get("FAKE_APP_NEW_FAIL"):
        sys.stderr.write("cannot create\n")
        sys.exit(1)
    print(json.dumps({"space": {"id": "sp-new"}}))
else:
    print("{}")
'''

FAKE_NODE = r'''
import json, os, sys
with open(os.environ["FAKE_NODE_LOG"], "a", encoding="utf-8") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "session": os.environ.get("PI_INTERCOM_SESSION_ID")}) + "\n")
if os.environ.get("FAKE_NODE_EXIT"):
    sys.stderr.write("broker down\n")
    sys.exit(int(os.environ["FAKE_NODE_EXIT"]))
'''


def lines_of(path):
    path = Path(path)
    return [json.loads(l) for l in path.read_text("utf-8").splitlines()] if path.exists() else []


def install_script(bin_dir, name, body):
    """A fake executable `name` running the Python `body`: a script on POSIX, name.cmd + name.py on win32."""
    bin_dir = Path(bin_dir)
    bin_dir.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        (bin_dir / (name + ".py")).write_text(body, "utf-8")
        (bin_dir / (name + ".cmd")).write_bytes(('@"%s" "%%~dp0%s.py" %%*\r\n' % (sys.executable, name)).encode("utf-8"))
    else:
        path = bin_dir / name
        path.write_text("#!%s\n%s" % (sys.executable, body), "utf-8")
        path.chmod(0o755)


def calls_of(rows, *names):
    return [c for c in rows if c and c[0] in names]


class RemoteBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="session_remote_")).resolve()
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.padir = self.tmp / "parent agent"
        self.radir = self.tmp / "remote agent"
        self.rproj = self.tmp / "remote proj"
        self.rproj.mkdir()
        self.hcbin = install_fake_hc(self.tmp / "hcbin")
        self.appbin = self.tmp / "appbin"
        self.pibin = self.tmp / "pibin"
        install_script(self.appbin, "herdr-app", FAKE_HERDR_APP)
        install_script(self.pibin, "node", FAKE_NODE)
        install_script(self.pibin, "pi", "print('pi 9.9.9')\n")
        cli = self.radir / "npm" / "node_modules" / "pi-intercom"
        cli.mkdir(parents=True)
        (cli / "cli.mjs").write_text("// fake\n", "utf-8")
        self.cli = cli / "cli.mjs"
        self.brief = self.tmp / "brief.md"
        self.brief.write_text("# Task\n\nDo the thing.\n", "utf-8")
        self.logs = {k: self.tmp / (k + ".log") for k in ("hc", "exec", "app", "node")}
        self.write_config({"alpha": {"parentName": "beta"}, "beta": {}, "gamma": {}})
        self.env = {"PATH": self.path(), "PI_CODING_AGENT_DIR": str(self.padir),
                    "FAKE_HC_LOG": str(self.logs["hc"]), "FAKE_HC_EXEC_LOG": str(self.logs["exec"]),
                    "FAKE_HC_STATE": str(self.tmp / "hcstate"), "FAKE_HC_MACHINES": json.dumps(HC_MACHINES),
                    "FAKE_APP_LOG": str(self.logs["app"]), "FAKE_APP_SPACES": json.dumps(SPACES),
                    "FAKE_NODE_LOG": str(self.logs["node"]), "FAKE_SCRIPTS": str(SCRIPTS), "FAKE_CLI": str(self.cli),
                    "FAKE_REMOTE_AGENT": str(self.radir)}
        for k in ("HC_TERMINAL_ID", "HC_SCOPE", "HC_TERMINAL_SOCKET", "HC_BIN", "HERDR_PANE_ID", "HERDR_BIN",
                  "PI_INTERCOM_STABLE_ID", "PI_INTERCOM_SESSION_ID", "PI_FOREMAN_HANDOFF_DIR", "PI_FOREMAN_REMOTE_PARENT",
                  "PI_FOREMAN_SESSION_MODEL", "FAKE_HC_FAIL", "FAKE_HC_CORE_DOWN", "FAKE_HC_EXEC_MODE", "FAKE_REMOTE_PATH",
                  "FAKE_SSH_PROTOCOL", "FAKE_REMOTE_HC_DOWN", "FAKE_APP_NEW_FAIL", "FAKE_NODE_EXIT"):
            self.env[k] = ""
        for k in os.environ:
            if k.startswith("PI_BG_"):
                self.env[k] = ""

    def path(self, hc=True, app=True):
        """A PATH of the fakes (fake hc and herdr-app optional) followed by the real one, minus the directories that hold a
        real hc or herdr-app (a developer machine may have both)."""
        parts = ([str(self.hcbin)] if hc else []) + ([str(self.appbin)] if app else []) + [str(self.pibin)]
        rest = [d for d in os.environ.get("PATH", "").split(os.pathsep)
                if d and not shutil.which("hc", path=d) and not shutil.which("herdr-app", path=d)]
        return os.pathsep.join(parts + rest)

    def write_config(self, machines, extra=None, adir=None):
        adir = Path(adir or self.padir)
        adir.mkdir(parents=True, exist_ok=True)
        cfg = {"sessions": {"machines": machines}}
        cfg.update(extra or {})
        (adir / "foreman.json").write_text(json.dumps(cfg), "utf-8")

    def apply_env(self, env, stack):
        e = dict(self.env, **env)
        stack.enter_context(mock.patch.dict(os.environ, e))
        for k, v in e.items():
            if v == "":
                os.environ.pop(k, None)

    def run_main(self, *argv, stdin=None, **env):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.ExitStack() as stack:
            self.apply_env(env, stack)
            stack.enter_context(contextlib.redirect_stdout(out))
            stack.enter_context(contextlib.redirect_stderr(err))
            if stdin is not None:
                stack.enter_context(mock.patch.object(sys, "stdin", io.TextIOWrapper(io.BytesIO(stdin), encoding="utf-8")))
            stack.enter_context(mock.patch.object(fsn, "intercom_cli", return_value=self.cli))
            code = fsn.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def remote(self, verb, params, raw=None, **env):
        """The remote side in this process: `remote <verb> --json` against the remote agent dir."""
        stdin = raw if raw is not None else json.dumps(params, ensure_ascii=False).encode("utf-8")
        renv = {"PI_CODING_AGENT_DIR": str(self.radir)}
        renv.update(env)
        code, out, err = self.run_main("remote", verb, "--json", stdin=stdin, **renv)
        reply = json.loads(out.strip().splitlines()[-1])
        return code, reply

    def open_args(self, *extra, machine="alpha", cwd=None, parent=PARENT):
        args = ["open", "demo", str(self.brief), "--machine", machine, "--cwd", str(cwd or self.rproj)]
        if parent:
            args += ["--parent-id", parent]
        return tuple(args) + extra

    def hc_calls(self, *names):
        return calls_of(lines_of(self.logs["hc"]), *names)

    def exec_calls(self):
        return lines_of(self.logs["exec"])

    def parent_registry(self):
        path = self.padir / "pi-foreman" / "state" / "sessions.json"
        return json.loads(path.read_text("utf-8"))["sessions"] if path.exists() else []

    def remote_registry(self):
        path = self.radir / "pi-foreman" / "state" / "sessions.json"
        return json.loads(path.read_text("utf-8"))["sessions"] if path.exists() else []

    def open_params(self, **over):
        p = {"label": "demo", "brief": "# Task\n", "cwd": str(self.rproj), "planFirst": False, "parentAddress": ADDRESS,
             "parentName": "beta", "trust": False, "dryRun": False}
        p.update(over)
        return p

    def remote_open(self, **over):
        code, reply = self.remote("open", self.open_params(**over))
        self.assertEqual((code, reply["ok"]), (0, True), reply)
        return reply

    def handoff(self, reply):
        return self.radir / "pi-foreman" / "handoffs" / reply["handoffName"]

    def opened(self):
        """A successful parent open: (parent registry entry, remote handoff dir)."""
        code, out, err = self.run_main(*self.open_args())
        self.assertEqual(code, 0, err)
        entry = self.parent_registry()[0]
        return entry, Path(entry["remoteHandoff"])


class ConfigTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="session_remote_cfg_")).resolve()
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.agent = self.tmp / "agent"
        self.agent.mkdir()
        self.project = self.tmp / "proj"
        (self.project / ".pi").mkdir(parents=True)
        (self.project / ".git").mkdir()

    def load(self, project=None, l2=None):
        if l2 is not None:
            (self.agent / "foreman.json").write_text(json.dumps(l2), "utf-8")
        if project is not None:
            (self.project / ".pi" / "foreman.json").write_text(json.dumps(project), "utf-8")
        return fc.load_config(agent_dir=str(self.agent), project_dir=str(self.project), trusted_project=True)

    def issues(self, cfg):
        out = []
        fc.validate_schema(cfg, fc.read_json(fc.SCHEMA_PATH), "", out)
        return out + fc.semantic_issues(cfg)

    def test_defaults(self):
        sessions = self.load()["config"]["sessions"]
        self.assertEqual(sessions, {"backend": "auto", "hc": {"outliveParent": True}, "machines": {},
                                    "remote": {"fetchTimeoutSeconds": 30}, "worktree": {"branchPrefix": "round"}})

    def test_machines_from_the_project_layer_are_ignored(self):
        r = self.load(project={"sessions": {"machines": {"alpha": {}}}}, l2={"sessions": {"machines": {"beta": {}}}})
        self.assertEqual(list(r["config"]["sessions"]["machines"]), ["beta"])
        self.assertTrue(any("sessions.machines" in w for w in r["warnings"]), r["warnings"])

    def test_schema_bounds_and_patterns(self):
        ok = {"sessions": {"machines": {"alpha": {"foremanArgv": ["powershell.exe", "-NoProfile", "-File", "C:/Program Files/fm/bin/foreman.ps1"],
                                                  "parentName": "beta", "space": "sp-1"}}}}
        self.assertEqual(self.issues(ok), [])
        self.assertEqual(self.issues({"sessions": {"remote": {"fetchTimeoutSeconds": 30}}}), [])
        for bad in ({"sessions": {"remote": {"fetchTimeoutSeconds": 4}}}, {"sessions": {"remote": {"fetchTimeoutSeconds": 601}}},
                    {"sessions": {"remote": {"fetchTimeoutSeconds": "30"}}}, {"sessions": {"remote": {"other": 1}}},
                    {"sessions": {"machines": {"alpha": {"foremanArgv": ["a;b"]}}}},
                    {"sessions": {"machines": {"alpha": {"foremanArgv": "foreman"}}}},
                    {"sessions": {"machines": {"alpha": {"space": "a b"}}}},
                    {"sessions": {"machines": {"alpha": {"parentName": "-x"}}}},
                    {"sessions": {"machines": {"-alpha": {}}}}, {"sessions": {"machines": {"a b": {}}}},
                    {"sessions": {"machines": {"alpha": {"unknown": 1}}}}):
            self.assertTrue(self.issues(bad), bad)

    def test_the_ssh_pull_and_outbox_keys_are_gone(self):
        for bad in ({"sessions": {"ssh": {"controlMaster": False}}}, {"sessions": {"pull": {"intervalSeconds": 20}}},
                    {"sessions": {"remoteInlineMaxBytes": 4096}},
                    {"sessions": {"machines": {"alpha": {"foremanCommand": "foreman"}}}},
                    {"sessions": {"machines": {"alpha": {"returnPath": "push"}}}}):
            self.assertTrue(self.issues(bad), bad)

    def test_remote_sessions_feature_follows_machines(self):
        import foreman_docs as fd
        feature = next(f for f in fd.load_features()["features"] if f["id"] == "remote-sessions")
        self.assertFalse(fd.switch_on(feature, self.load()["config"]))
        self.assertTrue(fd.switch_on(feature, self.load(l2={"sessions": {"machines": {"alpha": {}}}})["config"]))
        text = feature["description"] if "description" in feature else json.dumps(feature)
        self.assertIn("hc", text)
        self.assertNotIn("PR 4", text)
        self.assertIn("sessions.remote.fetchTimeoutSeconds", text)
        self.assertIn("foreman session remote notice", text)

    def test_fetch_timeout_is_user_or_overlay_only(self):
        r = self.load(project={"sessions": {"remote": {"fetchTimeoutSeconds": 99}}}, l2={"sessions": {"remote": {"fetchTimeoutSeconds": 60}}})
        self.assertEqual(r["config"]["sessions"]["remote"]["fetchTimeoutSeconds"], 60)
        self.assertNotEqual(r["config"]["sessions"]["remote"]["fetchTimeoutSeconds"], 99)
        self.assertTrue(any("sessions.remote" in w for w in r["warnings"]), r["warnings"])


class ProbeTest(RemoteBase):
    def probe(self, **env):
        return self.remote("probe", {"parentName": "beta", "parentAddress": ADDRESS}, **env)

    def test_probe_reply_shape(self):
        code, r = self.probe()
        self.assertEqual(code, 0)
        self.assertEqual(r["protocol"], 3)
        self.assertEqual((r["piVersion"], r["platform"]), ("pi 9.9.9", sys.platform))
        self.assertEqual(r["hc"], {"available": True, "coreUp": True, "version": "0.0.0-fake"})
        self.assertEqual((r["agentDir"], r["intercomMachineName"]), (str(self.radir), fsn.short_hostname()))
        self.assertIn("foremanVersion", r)
        for gone in ("herdr", "returnPath", "returnPathOk", "returnPathError", "relayCommand", "intercomVersion", "intercomMachine"):
            self.assertNotIn(gone, r)

    def test_intercom_machine_name_comes_from_the_intercom_config(self):
        (self.radir / "intercom").mkdir()
        (self.radir / "intercom" / "config.json").write_text(json.dumps({"crossMachine": {"machineName": " beta "}}), "utf-8")
        self.assertEqual(self.probe()[1]["intercomMachineName"], "beta")

    def test_core_down(self):
        self.assertEqual(self.probe(FAKE_HC_CORE_DOWN="1")[1]["hc"], {"available": True, "coreUp": False, "version": None})

    def test_no_hc_on_the_path(self):
        self.assertEqual(self.probe(PATH=self.path(hc=False))[1]["hc"], {"available": False, "coreUp": False, "version": None})

    def test_probe_refuses_bad_requests(self):
        code, r = self.remote("probe", {"parentName": "beta", "parentAddress": ADDRESS, "extra": 1})
        self.assertEqual((code, r["code"]), (1, "bad_request"))
        code, r = self.remote("probe", {"parentName": "alpha", "parentAddress": ADDRESS})
        self.assertEqual((code, r["code"]), (1, "bad_request"))

    def test_stdout_is_one_json_line(self):
        _, out, _ = self.run_main("remote", "probe", "--json", stdin=json.dumps({"parentName": "beta", "parentAddress": ADDRESS}).encode(),
                                  PI_CODING_AGENT_DIR=str(self.radir))
        self.assertEqual(len(out.splitlines()), 1)
        self.assertTrue(json.loads(out)["ok"])

    def test_bad_stdin(self):
        for raw in (b"not json", b"[1]", b"\xff\xfe"):
            code, r = self.remote("probe", None, raw=raw)
            self.assertEqual((code, r["code"]), (1, "bad_request"), raw)
        code, r = self.remote("probe", None, raw=b" " * (256 * 1024 + 1))
        self.assertEqual((code, r["code"]), (1, "too_large"))


class RemoteOpenTest(RemoteBase):
    def run_args(self):
        (call,) = self.hc_calls("run")
        return call

    def test_open_runs_the_child_under_the_remote_hc(self):
        reply = self.remote_open(space="sp-alpha")
        h = self.handoff(reply)
        self.assertEqual(reply["status"], "open")
        self.assertEqual(reply["hc"]["address"], "t1")
        self.assertNotIn("herdr", reply)
        self.assertRegex(reply["handoffName"], r"^\d{8}-\d{6}-demo$")
        self.assertEqual((h / "parent").read_text("utf-8").strip(), ADDRESS)
        self.assertEqual((h / "child").read_text("utf-8").strip(), reply["child"])
        brief = (h / "brief.md").read_text("utf-8")
        self.assertIn("remote notice", brief)
        self.assertIn("pi-foreman remote session `demo`", brief)
        launch = (h / "launch.txt").read_text("utf-8")
        # the launch line is in the form of the platform the child runs on: `K=V` words on POSIX, `$env:K='V'` on win32
        def assign(key, value):
            return "$env:%s='%s'" % (key, value) if fsn.host_platform() == "win32" else "%s=%s" % (key, value)
        self.assertIn(assign("PI_FOREMAN_REMOTE_PARENT", "1"), launch)
        self.assertIn(assign("PI_FOREMAN_PARENT_LABEL", "beta"), launch)
        self.assertIn(assign("PI_FOREMAN_PARENT_INTERCOM", ADDRESS), launch)
        entry = self.remote_registry()[0]
        self.assertEqual((entry["child"], entry["parent"], entry["status"], entry["backend"]), (reply["child"], ADDRESS, "open", "hc"))

    def test_hc_run_argv_has_the_labels_no_parent_and_bg(self):
        reply = self.remote_open(space="sp-alpha")
        run = self.run_args()
        head = run[:run.index("--")]
        self.assertEqual(head[:5], ["run", "--json", "--bg", "--no-notify", "--keep"])
        self.assertIn("--no-parent", head)
        self.assertNotIn("--outlive-parent", head)
        labels = [head[i + 1] for i, a in enumerate(head) if a == "--label"]
        self.assertEqual(labels, ["herdr.space=sp-alpha", "fm.child=" + reply["child"], "fm.parent=" + PARENT])
        self.assertEqual(head[head.index("--cwd") + 1], str(self.rproj))
        self.assertEqual(head[head.index("--name") + 1], fsn.hc_name(reply["child"]))
        self.assertEqual(run[run.index("--") + 1], "env" if sys.platform != "win32" else "powershell")

    def test_a_space_without_a_tab_label(self):
        self.remote_open(space="sp-alpha")
        self.assertFalse(any(a.startswith("herdr.tab=") for a in self.run_args()))

    def test_no_space_means_no_space_label(self):
        self.remote_open()
        self.assertFalse(any(a.startswith("herdr.") for a in self.run_args()))

    def test_win32_child_argv_names_pi_cmd(self):
        with mock.patch.object(fsn, "host_platform", return_value="win32"):
            reply = self.remote_open(space="sp-alpha")
        run = self.run_args()
        argv = run[run.index("--") + 1:]
        self.assertEqual(argv[:3], ["powershell", "-NoProfile", "-Command"])
        self.assertEqual(len(argv), 4)
        self.assertIn("; pi.cmd '", argv[3])
        self.assertNotIn("; pi '", argv[3])
        self.assertIn("$env:PI_FOREMAN_REMOTE_PARENT='1'", argv[3])
        self.assertEqual(reply["status"], "open")

    def test_open_stdout_is_exactly_one_json_line(self):
        _, out, _ = self.run_main("remote", "open", "--json", stdin=json.dumps(self.open_params()).encode("utf-8"),
                                  PI_CODING_AGENT_DIR=str(self.radir))
        self.assertEqual(len(out.strip().splitlines()), 1)
        self.assertTrue(json.loads(out)["ok"])

    def test_hc_run_failure_leaves_a_failed_entry_with_a_launch_line(self):
        real = fsn.hc

        def failing(binary, args, timeout=fsn.HC_TIMEOUT):
            if args and args[0] == "run":
                raise fsn.HcError("hc run exited 1: no core")
            return real(binary, args, timeout)

        with mock.patch.object(fsn, "hc", side_effect=failing):
            code, reply = self.remote("open", self.open_params())
        self.assertEqual((code, reply["status"]), (0, "failed"))
        self.assertTrue(reply["launch"])
        self.assertEqual(self.remote_registry()[0]["status"], "failed")

    def test_no_hc_on_the_remote_is_remote_launcher(self):
        rc, reply = self.remote("open", self.open_params(), PATH=self.path(hc=False))
        self.assertEqual((rc, reply["code"]), (1, "remote_launcher"))
        self.assertFalse((self.radir / "pi-foreman").exists())
        rc, reply = self.remote("open", self.open_params(dryRun=True), PATH=self.path(hc=False))
        self.assertEqual((rc, reply["code"]), (1, "remote_launcher"))

    def test_dry_run_writes_nothing(self):
        code, reply = self.remote("open", self.open_params(dryRun=True, space="sp-alpha"))
        self.assertEqual((code, reply["status"]), (0, "dryRun"))
        self.assertFalse((self.radir / "pi-foreman").exists())
        self.assertEqual(self.hc_calls("run"), [])

    def test_refusals(self):
        cases = [({"extra": 1}, "bad_request"), ({"label": "-bad"}, "bad_request"), ({"model": "a b"}, "bad_request"),
                 ({"parentAddress": "x"}, "bad_request"), ({"parentAddress": PARENT + "@alpha"}, "bad_request"),
                 ({"space": "a b"}, "bad_request"),
                 ({"cwd": str(self.tmp / "nowhere")}, "bad_cwd"), ({"cwd": str(self.tmp / "a;b")}, "refused"),
                 ({"brief": "x" * (64 * 1024 + 1)}, "too_large"), ({"planFirst": "yes"}, "bad_request")]
        for over, code in cases:
            rc, reply = self.remote("open", self.open_params(**over))
            self.assertEqual((rc, reply["ok"], reply.get("code")), (1, False, code), over)
        self.assertFalse((self.radir / "pi-foreman").exists())

    def test_rank_refusal_on_the_remote(self):
        ranks = [{"match": "big-*", "tier": 0}, {"match": "small-*", "tier": 2}]
        self.write_config({}, {"providers": {"prov": {"ranks": ranks}}}, adir=self.radir)
        rc, reply = self.remote("open", self.open_params(model="big-x", ownModel="small-y"))
        self.assertEqual((rc, reply["code"]), (1, "session_rank"))
        self.assertIn("tier 0", reply["error"])
        self.assertFalse((self.radir / "pi-foreman").exists())
        self.assertEqual(self.remote("open", self.open_params(model="small-x", ownModel="big-y"))[0], 0)

    def test_untrusted_project_resources(self):
        (self.rproj / ".pi").mkdir()
        rc, reply = self.remote("open", self.open_params())
        self.assertEqual((rc, reply["code"]), (1, "remote_untrusted"))
        self.assertFalse((self.radir / "pi-foreman").exists())
        self.assertEqual(self.hc_calls("run"), [])
        rc, reply = self.remote("open", self.open_params(dryRun=True, trust=True))
        self.assertEqual(rc, 0)
        self.assertEqual(foreman_trust.decision(self.radir, self.rproj), None)  # a dry run grants nothing
        rc, reply = self.remote("open", self.open_params(trust=True))
        self.assertEqual(rc, 0, reply)
        self.assertIs(foreman_trust.decision(self.radir, self.rproj), True)
        self.assertEqual(self.remote_registry()[0]["trusted"], str(self.rproj))
        self.assertEqual(self.remote("open", self.open_params())[0], 0)  # now stored: no flag needed

    def test_nearest_ancestor_decision_wins(self):
        (self.rproj / ".pi").mkdir()
        trust = self.radir / "trust.json"
        self.radir.mkdir(exist_ok=True)
        trust.write_text(json.dumps({str(self.tmp): True}), "utf-8")
        self.assertEqual(self.remote("open", self.open_params())[0], 0)
        trust.write_text(json.dumps({str(self.tmp): True, str(self.rproj): False}), "utf-8")
        rc, reply = self.remote("open", self.open_params())
        self.assertEqual((rc, reply["code"]), (1, "remote_untrusted"))
        rc, reply = self.remote("open", self.open_params(trust=True))  # an exact stored `false` is never overwritten
        self.assertEqual((rc, reply["code"]), (1, "remote_untrusted"))
        self.assertIs(foreman_trust.decision(self.radir, self.rproj), False)

    def test_ancestor_false_is_overridden_by_trust(self):
        (self.rproj / ".agents").mkdir()
        (self.radir).mkdir(exist_ok=True)
        (self.radir / "trust.json").write_text(json.dumps({str(self.tmp): False}), "utf-8")
        self.assertEqual(self.remote("open", self.open_params())[1]["code"], "remote_untrusted")
        self.assertEqual(self.remote("open", self.open_params(trust=True))[0], 0)
        self.assertIs(foreman_trust.decision(self.radir, self.rproj), True)

    def test_a_folder_without_resources_needs_no_trust(self):
        self.assertEqual(self.remote("open", self.open_params())[0], 0)
        self.assertFalse((self.radir / "trust.json").exists())


class DeliverTest(RemoteBase):
    def setUp(self):
        super().setUp()
        self.reply = self.remote_open()
        self.dir = self.handoff(self.reply)

    def params(self, **over):
        p = {"handoffName": self.reply["handoffName"], "parentAddress": ADDRESS, "kind": "ruling", "name": "ruling.md",
             "content": "APPROVED\n"}
        p.update(over)
        return p

    def deliver(self, **over):
        return self.remote("deliver", self.params(**over))

    def test_allowlisted_names(self):
        for kind, name in (("ruling", "ruling.md"), ("ruling", "ruling-plan.md"), ("ruling", "ruling-3.md"),
                           ("steer", "steer-2.md"), ("brief", "brief-1.md"), ("brief", "brief-999.md")):
            code, r = self.deliver(kind=kind, name=name, content="text for " + name)
            self.assertEqual((code, r["ok"]), (0, True), (name, r))
            self.assertEqual(Path(r["path"]), self.dir / name)
            self.assertEqual((self.dir / name).read_text("utf-8"), "text for " + name)
            self.assertEqual(r["sha256"], hashlib.sha256(("text for " + name).encode()).hexdigest())
            self.assertEqual(r["bytes"], len(("text for " + name).encode()))

    def test_other_names_are_refused(self):
        for kind, name in (("ruling", "result.md"), ("ruling", "../ruling.md"), ("ruling", "ruling-0.md"),
                           ("ruling", "ruling-1000.md"), ("ruling", "sub/ruling.md"), ("brief", "brief.md"),
                           ("steer", "ruling.md"), ("ruling", "steer-1.md"), ("brief", "parent"), ("ruling", "ruling-1.md.x"),
                           ("other", "ruling.md"), ("ruling", "")):
            code, r = self.deliver(kind=kind, name=name)
            self.assertEqual((code, r["code"]), (1, "bad_name"), (kind, name))
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), ["brief.md", "child", "launch.txt", "parent"])

    def test_wrong_session(self):
        code, r = self.deliver(parentAddress=OTHER + "@beta")
        self.assertEqual((code, r["code"]), (1, "wrong_session"))
        (self.dir / "parent").unlink()
        self.assertEqual(self.deliver()[1]["code"], "wrong_session")
        self.assertFalse((self.dir / "ruling.md").exists())

    def test_handoff_name_checks(self):
        for name in ("../x", "..", "20260101-000000-a/../b", "x", "20260101-000000-", "20260101-000000-a b", ""):
            code, r = self.deliver(handoffName=name)
            self.assertEqual((code, r["code"]), (1, "bad_request"), name)
        self.assertEqual(self.deliver(handoffName="20260101-000000-nothing")[1]["code"], "no_handoff")

    @unittest.skipIf(sys.platform == "win32", "symlinks need privileges on win32")
    def test_symlinked_handoff_dir_is_refused(self):
        link = self.dir.parent / "20260101-000000-link"
        link.symlink_to(self.dir, target_is_directory=True)
        self.assertEqual(self.deliver(handoffName=link.name)[1]["code"], "no_handoff")

    def test_size_cap(self):
        self.assertEqual(self.deliver(content="x" * (64 * 1024))[0], 0)
        code, r = self.deliver(content="x" * (64 * 1024 + 1))
        self.assertEqual((code, r["code"]), (1, "too_large"))
        self.assertEqual((self.dir / "ruling.md").stat().st_size, 64 * 1024)  # the refused write left the old file

    def test_cjk_content_within_the_stdin_cap(self):
        text = "\u6f22" * 21845  # 65535 bytes
        code, r = self.deliver(content=text)
        self.assertEqual((code, r["bytes"]), (0, 65535))
        self.assertEqual((self.dir / "ruling.md").read_text("utf-8"), text)
        code, r = self.deliver(content="\u6f22" * 21846)
        self.assertEqual((code, r["code"]), (1, "too_large"))

    def test_atomic_replace_leaves_no_temp_file(self):
        self.deliver(content="first")
        self.deliver(content="second")
        self.assertEqual((self.dir / "ruling.md").read_text("utf-8"), "second")
        self.assertEqual([p.name for p in self.dir.iterdir() if p.name.startswith(".deliver-")], [])

    def test_wake_names_the_file_and_the_child(self):
        code, r = self.deliver()
        self.assertTrue(r["woke"])
        call = lines_of(self.logs["node"])[-1]
        self.assertEqual(call["argv"][1:4], ["send", "--to", self.reply["child"]])
        self.assertEqual(call["argv"][-1], "Brief from %s: read %s and act on it" % (ADDRESS, self.dir / "ruling.md"))

    def test_failed_wake_keeps_the_file(self):
        code, r = self.remote("deliver", self.params(), FAKE_NODE_EXIT="1")
        self.assertEqual((code, r["ok"], r["woke"]), (0, True, False))
        self.assertEqual((self.dir / "ruling.md").read_text("utf-8"), "APPROVED\n")

    def test_unknown_and_missing_fields(self):
        self.assertEqual(self.deliver(extra=1)[1]["code"], "bad_request")
        p = self.params()
        del p["content"]
        self.assertEqual(self.remote("deliver", p)[1]["code"], "bad_request")
        self.assertEqual(self.deliver(content=5)[1]["code"], "bad_request")


class ArgvWordTest(unittest.TestCase):
    def test_words_the_shared_validator_accepts(self):
        for word in ("foreman", "/opt/fm/bin/foreman", "C:/Program Files/fm/foreman.cmd", "C:\\fm\\bin\\foreman.ps1",
                     "-NoProfile", "a b", "bin:x", "a.b_c-d"):
            self.assertTrue(fsn.argv_word(word), word)

    def test_a_word_with_a_space_is_ok_but_a_blank_one_is_not(self):
        self.assertTrue(fsn.argv_word("Program Files"))
        for word in ("", " ", "   "):
            self.assertFalse(fsn.argv_word(word), repr(word))

    def test_metacharacters_are_refused(self):
        for word in ("a;b", "a|b", "a&b", "a$b", "`x`", "a\"b", "a'b", "a>b", "a<b", "a(b)", "a*b", "a\nb", "a\tb", "a\u2018b",
                     "a\n", "x" * 201):
            self.assertFalse(fsn.argv_word(word), repr(word))
        for word in (5, None, ["a"]):
            self.assertFalse(fsn.argv_word(word))

    def test_the_first_word_is_checked_for_a_dash_after_stripping(self):
        for word in ("-x", " -x", "  -x ", "--"):
            self.assertFalse(fsn.argv_first_word(word), repr(word))
        for word in ("foreman", "C:/fm/foreman.cmd", "a -x"):
            self.assertTrue(fsn.argv_first_word(word), repr(word))


class MachineEntryTest(RemoteBase):
    def entry(self, machines, name="alpha"):
        with mock.patch.object(fsn, "session_config", return_value={"machines": machines}):
            return fsn.machine_entry(self.padir, name)

    def test_the_default_argv_is_foreman(self):
        entry, argv = self.entry({"alpha": {}})
        self.assertEqual((entry, argv), ({}, ["foreman"]))

    def test_a_custom_argv_is_returned_with_the_entry(self):
        words = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:/Program Files/fm/bin/foreman.ps1"]
        entry, argv = self.entry({"alpha": {"foremanArgv": words, "space": "sp-1"}})
        self.assertEqual((argv, entry["space"]), (words, "sp-1"))

    def test_one_to_eight_words(self):
        self.assertEqual(self.entry({"alpha": {"foremanArgv": ["f"] * 8}})[1], ["f"] * 8)
        for words in ([], ["f"] * 9, "foreman", [5], None):
            with self.assertRaises(fsn.Refused) as cm:
                self.entry({"alpha": {"foremanArgv": words}})
            self.assertEqual(cm.exception.code, "machine_not_allowed", words)

    def test_a_bad_word_or_a_leading_dash_is_refused(self):
        for words in (["foreman;rm"], ["a", "b|c"], ["-oProxyCommand=x"], ["--version"], ["foreman", "a\"b"]):
            with self.assertRaises(fsn.Refused) as cm:
                self.entry({"alpha": {"foremanArgv": words}})
            self.assertEqual(cm.exception.code, "machine_not_allowed", words)

    def test_a_leading_dash_is_fine_after_the_first_word(self):
        self.assertEqual(self.entry({"alpha": {"foremanArgv": ["powershell.exe", "-NoProfile"]}})[1], ["powershell.exe", "-NoProfile"])

    def test_unknown_machine_and_case_mismatch(self):
        for name in ("delta", "ALPHA", "Alpha", "", "a b", "alpha\n"):
            with self.assertRaises(fsn.Refused) as cm:
                self.entry({"alpha": {}}, name)
            self.assertEqual(cm.exception.code, "machine_not_allowed", name)

    def test_two_entries_differing_in_case_are_two_machines(self):
        machines = {"alpha": {"foremanArgv": ["one"]}, "ALPHA": {"foremanArgv": ["two"]}}
        self.assertEqual(self.entry(machines, "alpha")[1], ["one"])
        self.assertEqual(self.entry(machines, "ALPHA")[1], ["two"])

    def test_hc_machine_ls_is_the_allowlist_with_exact_case(self):
        binary = str(self.hcbin / ("hc.cmd" if sys.platform == "win32" else "hc"))
        with mock.patch.dict(os.environ, dict(self.env, PATH=self.path())):
            os.environ.pop("HC_BIN", None)
            fsn.check_hc_machine(binary, "alpha")
            for listed, asked in (("ALPHA", "alpha"), ("alpha", "Alpha"), ("alpha-2", "alpha"), ("beta", "alpha")):
                os.environ["FAKE_HC_MACHINES"] = json.dumps([listed])
                with self.assertRaises(fsn.Refused) as cm:
                    fsn.check_hc_machine(binary, asked)
                self.assertEqual(cm.exception.code, "machine_unknown", (listed, asked))
            os.environ["FAKE_HC_MACHINES"] = json.dumps(["alpha", "ALPHA"])  # two entries of different case: exact match wins
            fsn.check_hc_machine(binary, "alpha")
            fsn.check_hc_machine(binary, "ALPHA")
            os.environ["FAKE_HC_FAIL"] = "1"
            with self.assertRaises(fsn.Refused) as cm:
                fsn.check_hc_machine(binary, "alpha")
            self.assertEqual(cm.exception.code, "machine_unknown")


class HcExecVerbTest(unittest.TestCase):
    """hc_exec_verb against a stubbed subprocess: the envelope handling, with no fake binary."""

    def envelope(self, stdout=b"", stderr=b"", code=0, timed_out=False):
        return {"code": code, "ms": 5, "signal": None, "stderr": base64.b64encode(stderr).decode("ascii"),
                "stdout": base64.b64encode(stdout).decode("ascii"), "timed_out": timed_out, "truncated": False}

    def run_verb(self, env, returncode=0, stderr=b"", argv=("foreman",)):
        seen = {}

        def fake_run(cmd, **kw):
            seen.update(cmd=cmd, kw=kw)
            return subprocess.CompletedProcess(cmd, returncode, json.dumps(env).encode("utf-8") if env is not None else b"", stderr)

        with mock.patch.object(fsn.subprocess, "run", side_effect=fake_run):
            try:
                return fsn.hc_exec_verb("/x/hc", "alpha", list(argv), "probe", {"a": "\u6f22"}, 15), seen
            finally:
                self.seen = seen

    def test_the_command_line(self):
        reply, seen = self.run_verb(self.envelope(b'{"ok": true, "protocol": 3}\n'), argv=("powershell.exe", "-File", "C:/a b/f.ps1"))
        self.assertEqual(reply, {"ok": True, "protocol": 3})
        self.assertEqual(seen["cmd"], ["/x/hc", "exec", "--on", "alpha", "--timeout", "15", "-i", "--json", "--",
                                       "powershell.exe", "-File", "C:/a b/f.ps1", "session", "remote", "probe", "--json"])
        self.assertEqual(json.loads(seen["kw"]["input"].decode("utf-8")), {"a": "\u6f22"})
        self.assertNotIn("shell", seen["kw"])

    def test_utf8_then_cp850(self):
        self.assertEqual(fsn.decode_hc_text(base64.b64encode("caf\u00e9 \u6f22".encode("utf-8")).decode()), "caf\u00e9 \u6f22")
        self.assertEqual(fsn.decode_hc_text(base64.b64encode("caf\u00e9".encode("cp850")).decode()), "caf\u00e9")
        self.assertEqual(fsn.decode_hc_text("not base64!"), "")
        self.assertEqual(fsn.decode_hc_text(None), "")

    def test_a_stderr_in_cp850_reaches_the_message(self):
        with self.assertRaises(fsn.Unreachable) as cm:
            self.run_verb(self.envelope(b"", "caf\u00e9 failed".encode("cp850"), code=1))
        self.assertEqual(str(cm.exception), "remote alpha unreachable: caf\u00e9 failed")

    def test_hc_failures_are_unreachable(self):
        cases = [(self.envelope(timed_out=True), 0, b"", "no answer within 15 s"),
                 (None, 1, b'{"error": {"kind": "spawn_failed"}}', "spawn_failed"),
                 (self.envelope(b"not json\n"), 0, b"", "no usable reply"),
                 ({"code": "x"}, 0, b"", "without a result"),
                 (None, 0, b"", "without a result")]
        for env, rc, err, text in cases:
            with self.assertRaises(fsn.Unreachable) as cm:
                self.run_verb(env, rc, err)
            self.assertTrue(str(cm.exception).startswith("remote alpha unreachable: "), str(cm.exception))
            self.assertIn(text, str(cm.exception))

    def test_control_characters_of_a_remote_error_are_stripped(self):
        out = b'{"ok": false, "code": "bad\\u001b[31m_cwd", "error": "no\\u001b]0;x\\u0007 dir\\u009b\\u007f\\n!"}\n'
        with self.assertRaises(fsn.Refused) as cm:
            self.run_verb(self.envelope(out, code=1))
        self.assertEqual((cm.exception.code, str(cm.exception)), ("bad[31m_cwd", "remote alpha: no]0;x dir!"))

    def test_control_characters_of_hc_stderr_are_stripped(self):
        dirty = b"bo\x1b[31mom\x1b]0;x\x07\xc2\x9b!\x7f"
        with self.assertRaises(fsn.Unreachable) as cm:  # hc itself failed: its own stderr
            self.run_verb(None, 1, dirty)
        self.assertEqual(str(cm.exception), "remote alpha unreachable: bo[31mom]0;x!")
        with self.assertRaises(fsn.Unreachable) as cm:  # no usable reply: the remote's stderr
            self.run_verb(self.envelope(b"not json\n", dirty, code=1))
        self.assertEqual(str(cm.exception), "remote alpha unreachable: bo[31mom]0;x!")
        with mock.patch.object(fsn.subprocess, "run", side_effect=OSError("go\x1b[2Jne")):
            with self.assertRaises(fsn.Unreachable) as cm:
                fsn.hc_exec_verb("/x/hc", "alpha", ["foreman"], "probe", {}, 15)
        self.assertEqual(str(cm.exception), "remote alpha unreachable: go[2Jne")

    def test_main_prints_unreachable_without_control_characters(self):
        with mock.patch.object(fsn, "cmd_list", side_effect=fsn.Unreachable("x\x1b[2Jy\x07")):
            code = self.main_err("list")
        self.assertEqual(code, (1, "pi-foreman session: x[2Jy\n"))

    def main_err(self, *argv):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            return fsn.main(list(argv)), err.getvalue()

    def test_a_banner_before_the_json_line_is_skipped(self):
        reply, _ = self.run_verb(self.envelope(b'Welcome\r\n{"ok": true}\r\n\r\n'))
        self.assertEqual(reply, {"ok": True})

    def test_a_remote_refusal_keeps_its_code(self):
        with self.assertRaises(fsn.Refused) as cm:
            self.run_verb(self.envelope(b'{"ok": false, "code": "bad_cwd", "error": "no dir"}\n', code=1))
        self.assertEqual((cm.exception.code, str(cm.exception)), ("bad_cwd", "remote alpha: no dir"))
        self.assertNotIsInstance(cm.exception, fsn.Unreachable)

    def test_a_missing_or_timed_out_subprocess(self):
        with mock.patch.object(fsn.subprocess, "run", side_effect=subprocess.TimeoutExpired("hc", 25)):
            with self.assertRaises(fsn.Unreachable) as cm:
                fsn.hc_exec_verb("/x/hc", "alpha", ["foreman"], "probe", {}, 15)
        self.assertIn("no answer within 15 s", str(cm.exception))
        with mock.patch.object(fsn.subprocess, "run", side_effect=OSError("gone")):
            with self.assertRaises(fsn.Unreachable):
                fsn.hc_exec_verb("/x/hc", "alpha", ["foreman"], "probe", {}, 15)


class SpaceTest(RemoteBase):
    def space(self, entry=None, cwd="/w", **env):
        with mock.patch.dict(os.environ, dict(self.env, **env)):
            for k, v in env.items():
                if v == "":
                    os.environ.pop(k, None)
            return fsn.machine_space(entry or {}, "alpha", cwd)

    def test_a_pinned_space_asks_nobody(self):
        self.assertEqual(self.space({"space": "sp-pin"}), "sp-pin")
        self.assertEqual(lines_of(self.logs["app"]), [])

    def test_the_first_space_of_the_machine_is_used(self):
        self.assertEqual(self.space(), "sp-alpha")
        self.assertEqual(lines_of(self.logs["app"]), [["ls"]])

    def test_a_missing_space_is_created_with_space_new(self):
        self.assertEqual(self.space(cwd="/w", FAKE_APP_SPACES=json.dumps([{"id": "sp-beta", "machine": "beta"}])), "sp-new")
        ls, new = lines_of(self.logs["app"])
        self.assertEqual(ls, ["ls"])
        self.assertEqual(new[:2], ["do", "space.new"])
        self.assertEqual(json.loads(new[2]), {"name": "alpha", "machine": "alpha", "folder": "/w"})

    def test_space_new_failing_is_no_remote_space(self):
        with self.assertRaises(fsn.Refused) as cm:
            self.space(FAKE_APP_SPACES="[]", FAKE_APP_NEW_FAIL="1")
        self.assertEqual(cm.exception.code, "no_remote_space")

    def test_without_herdr_app_there_is_no_space(self):
        self.assertIsNone(self.space(PATH=self.path(app=False)))


class ParentTest(RemoteBase):
    def refused(self, *args, code, **env):
        rc, out, err = self.run_main(*args, **env)
        self.assertEqual(rc, 1, (out, err))
        self.assertIn("[%s]" % code, err)
        self.assertEqual(self.parent_registry(), [])
        self.assertFalse((self.padir / "pi-foreman").exists())
        return err

    def test_open_success(self):
        rc, out, err = self.run_main(*self.open_args())
        self.assertEqual(rc, 0, err)
        entry = self.parent_registry()[0]
        calls = self.exec_calls()
        self.assertEqual([c["argv"] for c in calls], [["foreman", "session", "remote", "probe", "--json"],
                                                       ["foreman", "session", "remote", "open", "--json"]])
        self.assertEqual(json.loads(calls[0]["stdin"]), {"parentName": "beta", "parentAddress": ADDRESS})
        sent = json.loads(calls[1]["stdin"])
        self.assertEqual((sent["label"], sent["cwd"], sent["parentAddress"], sent["trust"], sent["dryRun"], sent["space"]),
                         ("demo", str(self.rproj), ADDRESS, False, False, "sp-alpha"))
        # the brief goes out as the file's exact bytes (CRLF on Windows, where write_text wrote them)
        self.assertEqual(sent["brief"], self.brief.read_bytes().decode("utf-8"))
        full = self.hc_calls("machine", "exec")
        self.assertEqual(full[0], ["machine", "ls", "--json"])
        self.assertEqual(full[1][:9], ["exec", "--on", "alpha", "--timeout", "15", "-i", "--json", "--", "foreman"])
        self.assertEqual(full[2][:5], ["exec", "--on", "alpha", "--timeout", "60"])
        handoff_name = entry["handoffName"]
        mirror = self.padir / "pi-foreman" / "remote" / "alpha" / handoff_name
        self.assertEqual({k: entry[k] for k in ("label", "parent", "parentAddress", "machine", "originMachine", "handoffName",
                                                "mirror", "handoff", "status", "lastError", "briefs", "last", "cwd", "backend")},
                         {"label": "demo", "parent": PARENT, "parentAddress": ADDRESS, "machine": "alpha",
                          "originMachine": fsn.short_hostname(), "handoffName": handoff_name, "mirror": str(mirror),
                          "handoff": str(mirror), "status": "open", "lastError": None, "briefs": 0, "last": None,
                          "cwd": str(self.rproj), "backend": "hc"})
        self.assertEqual(entry["hc"], {"address": "alpha/t1", "space": "sp-alpha", "tab": None})
        self.assertEqual(entry["remoteHandoff"], str(self.radir / "pi-foreman" / "handoffs" / handoff_name))
        self.assertEqual((entry["remote"]["protocol"], entry["remote"]["piVersion"], entry["remote"]["platform"]),
                         (3, "pi 9.9.9", sys.platform))
        self.assertTrue(mirror.is_dir() and not list(mirror.iterdir()))
        remote_entry = self.remote_registry()[0]
        self.assertEqual((remote_entry["child"], remote_entry["parent"]), (entry["child"], ADDRESS))
        self.assertTrue((Path(entry["remoteHandoff"]) / "brief.md").is_file())
        self.assertIn("remote: alpha", out)
        self.assertIn("opened under hc on alpha", out)
        for removed in ("returnPath", "pulledAt", "remoteLive"):
            self.assertNotIn(removed, entry)

    def test_the_remote_run_carries_the_space_looked_up_by_the_parent(self):
        self.assertEqual(self.run_main(*self.open_args())[0], 0)
        (run,) = self.hc_calls("run")
        self.assertIn("herdr.space=sp-alpha", run)
        self.assertEqual(lines_of(self.logs["app"]), [["ls"]])

    def test_a_pinned_space_wins_over_the_listing(self):
        self.write_config({"alpha": {"parentName": "beta", "space": "sp-pin"}})
        self.assertEqual(self.run_main(*self.open_args())[0], 0)
        self.assertEqual(json.loads(self.exec_calls()[1]["stdin"])["space"], "sp-pin")
        self.assertEqual(lines_of(self.logs["app"]), [])

    def test_without_herdr_app_the_child_runs_but_is_not_shown(self):
        rc, out, err = self.run_main(*self.open_args(), PATH=self.path(app=False))
        self.assertEqual(rc, 0, err)
        self.assertIn("opened under hc on alpha", out)
        self.assertIn("not shown: no herdr-app space", out)
        self.assertNotIn("space", json.loads(self.exec_calls()[1]["stdin"]))
        (run,) = self.hc_calls("run")
        self.assertFalse(any(a.startswith("herdr.") for a in run))
        self.assertIsNone(self.parent_registry()[0]["hc"]["space"])

    def test_no_space_and_space_new_failing_is_no_remote_space(self):
        self.refused(*self.open_args(), code="no_remote_space", FAKE_APP_SPACES="[]", FAKE_APP_NEW_FAIL="1")
        self.assertEqual(len(self.exec_calls()), 1)  # the probe only
        self.assertEqual(self.hc_calls("run"), [])

    def test_a_missing_space_is_created_for_the_machine(self):
        self.assertEqual(self.run_main(*self.open_args(), FAKE_APP_SPACES="[]")[0], 0)
        self.assertEqual(json.loads(self.exec_calls()[1]["stdin"])["space"], "sp-new")
        self.assertEqual(lines_of(self.logs["app"])[1][:2], ["do", "space.new"])

    def test_a_windows_foreman_argv_is_passed_as_words(self):
        words = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:/Program Files/fm/bin/foreman.ps1"]
        self.write_config({"alpha": {"parentName": "beta", "foremanArgv": words}})
        self.assertEqual(self.run_main(*self.open_args())[0], 0)
        self.assertEqual([c["argv"] for c in self.exec_calls()],
                         [words + ["session", "remote", "probe", "--json"], words + ["session", "remote", "open", "--json"]])

    def test_parent_name_defaults_to_the_short_hostname_not_the_intercom_config(self):
        self.write_config({"alpha": {}})
        (self.padir / "intercom").mkdir()
        (self.padir / "intercom" / "config.json").write_text(json.dumps({"crossMachine": {"machineName": "beta"}}), "utf-8")
        with mock.patch.object(fsn, "short_hostname", return_value="gamma"):
            self.assertEqual(self.run_main(*self.open_args())[0], 0)
        self.assertEqual(json.loads(self.exec_calls()[0]["stdin"])["parentName"], "gamma")

    def test_parent_name_default_without_any_intercom_config(self):
        self.write_config({"alpha": {}})
        with mock.patch.object(fsn, "short_hostname", return_value="gamma"):
            self.assertEqual(self.run_main(*self.open_args())[0], 0)
        self.assertEqual(json.loads(self.exec_calls()[0]["stdin"])["parentName"], "gamma")

    def test_a_banner_line_before_the_json_is_ignored(self):
        real = fsn.decode_hc_text
        with mock.patch.object(fsn, "decode_hc_text", side_effect=lambda b64: "Welcome\n" + real(b64)):
            self.assertEqual(self.run_main(*self.open_args())[0], 0)
        self.assertEqual(len(self.parent_registry()), 1)

    def test_unlisted_machine(self):
        err = self.refused(*self.open_args(machine="delta"), code="machine_not_allowed")
        self.assertEqual(self.hc_calls("machine", "exec"), [])
        self.write_config({})
        self.refused(*self.open_args(), code="machine_not_allowed")
        self.assertEqual(self.hc_calls("machine", "exec"), [])
        self.assertIn("sessions.machines", err)

    def test_machines_listed_only_in_the_project_layer_are_not_allowed(self):
        self.write_config({})
        proj = self.tmp / "p2"
        (proj / ".pi").mkdir(parents=True)
        (proj / ".pi" / "foreman.json").write_text(json.dumps({"sessions": {"machines": {"alpha": {}}}}), "utf-8")
        self.refused(*self.open_args(cwd=proj), code="machine_not_allowed")

    def test_hc_missing(self):
        self.refused(*self.open_args(), code="hc_missing", PATH=self.path(hc=False))
        self.refused(*self.open_args(), code="hc_missing", HC_BIN=str(self.tmp / "no-such-hc"))
        self.assertEqual(self.exec_calls(), [])

    def test_hc_bin_names_the_hc(self):
        real = str(self.hcbin / ("hc.cmd" if sys.platform == "win32" else "hc"))
        rc, out, err = self.run_main(*self.open_args(), PATH=self.path(hc=False), HC_BIN=real, FAKE_REMOTE_PATH=self.path())
        self.assertEqual(rc, 0, err)

    def test_machine_unknown(self):
        self.refused(*self.open_args(), code="machine_unknown", FAKE_HC_MACHINES=json.dumps(["beta"]))
        self.refused(*self.open_args(), code="machine_unknown", FAKE_HC_MACHINES=json.dumps(["ALPHA"]))  # exact case
        self.refused(*self.open_args(), code="machine_unknown", FAKE_HC_MACHINES="[]")
        self.write_config({"alpha": {}, "delta": {}})
        self.refused(*self.open_args(machine="delta"), code="machine_unknown")
        self.refused(*self.open_args(), code="machine_unknown", FAKE_HC_FAIL="1")  # hc machine ls itself fails: fail closed
        self.assertEqual(self.hc_calls("exec"), [])

    def test_no_return_path_without_an_opener_id(self):
        self.refused(*self.open_args(parent=None), code="no_return_path")
        self.assertEqual(self.hc_calls("machine", "exec"), [])

    def test_cwd_is_required_and_trust_needs_a_machine(self):
        self.refused("open", "demo", str(self.brief), "--machine", "alpha", "--parent-id", PARENT, code="cwd_required")
        rc, out, err = self.run_main("open", "demo", str(self.brief), "--trust", "--cwd", str(self.tmp), "--parent-id", PARENT)
        self.assertEqual(rc, 1)
        self.assertIn("--trust needs --machine", err)

    def test_remote_cwd_is_passed_unresolved(self):
        self.assertEqual(self.run_main(*self.open_args(cwd="/home/u/p"))[0], 1)  # the remote refuses: no such directory
        self.assertEqual(json.loads(self.exec_calls()[1]["stdin"])["cwd"], "/home/u/p")

    def test_rank_refusal_happens_before_any_hc_call(self):
        ranks = [{"match": "big-*", "tier": 0}, {"match": "small-*", "tier": 2}]
        self.write_config({"alpha": {"parentName": "beta"}}, {"providers": {"prov": {"ranks": ranks}}})
        err = self.refused(*self.open_args("--model", "big-x", "--own-model", "small-y"), code="session_rank")
        self.assertIn("tier 0", err)
        self.assertEqual(self.hc_calls("machine", "exec"), [])

    def test_remote_protocol(self):
        err = self.refused(*self.open_args(), code="remote_protocol", FAKE_SSH_PROTOCOL="4")
        self.assertIn("remote alpha speaks protocol 4, this side speaks 3;", err)
        self.assertEqual(len(self.exec_calls()), 1)

    def test_remote_missing(self):
        self.refused(*self.open_args(), code="remote_missing", FAKE_REMOTE_PATH=str(self.hcbin))
        self.assertEqual(self.remote_registry(), [])

    def test_remote_launcher_when_the_remote_core_is_down_or_hc_is_absent(self):
        err = self.refused(*self.open_args(), code="remote_launcher", FAKE_REMOTE_HC_DOWN="1")
        self.assertIn("alpha has no herdr-core answering (hc available: True, core up: False)", err)
        err = self.refused(*self.open_args(), code="remote_launcher", FAKE_REMOTE_PATH=str(self.pibin))
        self.assertIn("(hc available: False, core up: False)", err)
        self.assertEqual(len(self.exec_calls()), 2)  # a probe each, never an open
        self.assertEqual(self.hc_calls("run"), [])
        self.assertEqual(lines_of(self.logs["app"]), [])

    def test_remote_refusals_are_passed_through(self):
        (self.rproj / ".pi").mkdir()
        err = self.refused(*self.open_args(), code="remote_untrusted")
        self.assertIn("remote alpha", err)
        self.assertEqual(len(self.exec_calls()), 2)
        self.assertEqual(self.run_main(*self.open_args("--trust"))[0], 0)
        self.assertIs(foreman_trust.decision(self.radir, self.rproj), True)

    def test_dry_run_writes_nothing_on_either_side(self):
        rc, out, err = self.run_main(*self.open_args("--dry-run"))
        self.assertEqual(rc, 0, err)
        self.assertEqual(json.loads(self.exec_calls()[1]["stdin"])["dryRun"], True)
        self.assertNotIn("space", json.loads(self.exec_calls()[1]["stdin"]))
        self.assertIn("dry run: nothing was written on either machine", out)
        self.assertEqual(self.parent_registry(), [])
        self.assertFalse((self.padir / "pi-foreman").exists())
        self.assertFalse((self.radir / "pi-foreman").exists())
        self.assertEqual(self.hc_calls("run"), [])
        self.assertEqual(lines_of(self.logs["app"]), [])  # no space is looked up or created

    def test_unreachable_leaves_no_local_entry(self):
        for mode, text in (("timed_out", "no answer within 15 s"), ("spawn_failed", "spawn_failed"),
                           ("garbage", "no usable reply")):
            rc, out, err = self.run_main(*self.open_args(), FAKE_HC_EXEC_MODE=mode)
            self.assertEqual(rc, 1, mode)
            self.assertIn("remote alpha unreachable: ", err)
            self.assertIn(text, err)
            self.assertNotIn("refused [", err)
            self.assertEqual(self.parent_registry(), [])
            self.assertFalse((self.padir / "pi-foreman").exists())
            self.assertFalse((self.radir / "pi-foreman").exists())
        self.assertEqual(self.hc_calls("run"), [])

    def test_open_unreachable_after_a_good_probe(self):
        real = fsn.hc_exec_verb

        def flaky(binary, name, argv, verb, payload, timeout):
            if verb == "open":
                raise fsn.Unreachable("remote %s unreachable: dropped" % name)
            return real(binary, name, argv, verb, payload, timeout)

        with mock.patch.object(fsn, "hc_exec_verb", side_effect=flaky):
            rc, out, err = self.run_main(*self.open_args())
        self.assertEqual((rc, self.parent_registry()), (1, []))
        self.assertIn("remote alpha unreachable: dropped", err)

    def test_timeouts_per_verb(self):
        self.assertEqual((fsn.PROBE_TIMEOUT, fsn.OPEN_TIMEOUT, fsn.DELIVER_TIMEOUT, fsn.CLOSE_TIMEOUT), (15, 60, 20, 20))
        self.assertEqual(self.run_main(*self.open_args())[0], 0)
        seen = [c[c.index("--timeout") + 1] for c in self.hc_calls("exec")]
        self.assertEqual(seen, ["15", "60"])

    def test_local_open_is_unchanged_by_the_new_flags(self):
        proj = self.tmp / "local"
        proj.mkdir()
        rc, out, err = self.run_main("open", "demo", str(self.brief), "--cwd", str(proj), "--parent-id", "parent-1", "--dry-run")
        self.assertEqual(rc, 0, err)
        self.assertEqual(self.hc_calls("machine", "exec"), [])
        self.assertTrue(out.startswith("handoff: "))

    def test_session_list_shows_the_hc_address_of_a_remote_child(self):
        self.assertEqual(self.run_main(*self.open_args())[0], 0)
        rc, out, err = self.run_main("list")
        self.assertEqual(rc, 0, err)
        (row,) = [l for l in out.splitlines() if l.strip().startswith("demo")]
        self.assertTrue(row.rstrip().endswith("hc:alpha/t1"), row)
        self.assertEqual(json.loads(self.run_main("list", "--json")[1])["sessions"][0]["hc"]["address"], "alpha/t1")


class BriefTest(RemoteBase):
    def setUp(self):
        super().setUp()
        self.entry, self.rh = self.opened()

    def send(self, text, **env):
        return self.run_main("brief", "demo", text, "--parent-id", PARENT, **env)

    def test_text_becomes_the_next_numbered_brief(self):
        rc, out, err = self.send("please also check the docs")
        self.assertEqual(rc, 0, err)
        self.assertEqual((self.rh / "brief-1.md").read_text("utf-8"), "please also check the docs")
        self.assertEqual(self.send("again")[0], 0)
        self.assertEqual((self.rh / "brief-2.md").read_text("utf-8"), "again")
        entry = self.parent_registry()[0]
        self.assertEqual((entry["briefs"], entry["lastError"]), (2, None))
        last = self.exec_calls()[-1]
        sent = json.loads(last["stdin"])
        self.assertEqual((sent["kind"], sent["name"], sent["parentAddress"], sent["handoffName"]),
                         ("brief", "brief-2.md", ADDRESS, self.entry["handoffName"]))
        self.assertEqual(last["argv"], ["foreman", "session", "remote", "deliver", "--json"])
        self.assertEqual(self.hc_calls("exec")[-1][4], "20")
        call = lines_of(self.logs["node"])[-1]
        self.assertEqual(call["argv"][1:4], ["send", "--to", self.entry["child"]])

    def test_allowlisted_basename_keeps_its_name_and_kind(self):
        for name, kind in (("ruling.md", "ruling"), ("ruling-plan.md", "ruling"), ("ruling-2.md", "ruling"),
                           ("steer-1.md", "steer"), ("brief-7.md", "brief")):
            f = self.tmp / name
            f.write_text("content of " + name, "utf-8")
            self.assertEqual(self.send(str(f))[0], 0, name)
            sent = json.loads(self.exec_calls()[-1]["stdin"])
            self.assertEqual((sent["kind"], sent["name"], sent["content"]), (kind, name, "content of " + name))
            self.assertEqual((self.rh / name).read_text("utf-8"), "content of " + name)

    def test_rulings_are_counted_apart_from_briefs(self):
        reg = self.padir / "pi-foreman" / "state" / "sessions.json"

        def counts():
            e = [s for s in json.loads(reg.read_text("utf-8"))["sessions"] if s["child"] == self.entry["child"]][-1]
            return e.get("briefs"), e.get("rulings")

        for name, want in (("brief-7.md", (1, None)), ("steer-1.md", (2, None)), ("ruling.md", (3, 1)), ("ruling-2.md", (4, 2))):
            f = self.tmp / name
            f.write_text("x", "utf-8")
            self.assertEqual(self.send(str(f))[0], 0, name)
            self.assertEqual(counts(), want, name)

    def test_other_files_become_numbered_briefs(self):
        f = self.tmp / "notes.md"
        f.write_text("some notes", "utf-8")
        self.assertEqual(self.send(str(f))[0], 0)
        self.assertEqual((self.rh / "brief-1.md").read_text("utf-8"), "some notes")
        self.assertEqual(self.parent_registry()[0]["briefs"], 1)

    def test_cjk_brief_over_hc(self):
        text = "\u6f22" * 21845
        self.assertEqual(self.send(text)[0], 0)
        self.assertEqual((self.rh / "brief-1.md").read_text("utf-8"), text)

    def test_failure_sets_last_error_and_exit_1(self):
        rc, out, err = self.send("hello", FAKE_HC_EXEC_MODE="timed_out")
        self.assertEqual(rc, 1)
        self.assertIn("remote alpha unreachable", err)
        entry = self.parent_registry()[0]
        self.assertEqual(entry["briefs"], 0)
        self.assertIn("unreachable", entry["lastError"])
        self.assertFalse((self.rh / "brief-1.md").exists())
        self.assertEqual(self.send("hello")[0], 0)  # a later success clears it
        entry = self.parent_registry()[0]
        self.assertEqual((entry["briefs"], entry["lastError"]), (1, None))

    def test_a_machine_gone_from_hc_is_refused_and_recorded(self):
        rc, out, err = self.send("hello", FAKE_HC_MACHINES=json.dumps(["beta"]))
        self.assertEqual(rc, 1)
        self.assertIn("[machine_unknown]", err)
        self.assertIn("[machine_unknown]", self.parent_registry()[0]["lastError"])

    def test_remote_refusal_is_recorded(self):
        reg = self.padir / "pi-foreman" / "state" / "sessions.json"
        data = json.loads(reg.read_text("utf-8"))
        data["sessions"][0]["parentAddress"] = OTHER + "@beta"
        reg.write_text(json.dumps(data), "utf-8")
        rc, out, err = self.send("hello")
        self.assertEqual(rc, 1)
        self.assertIn("[wrong_session]", err)
        self.assertIn("does not belong", err)
        self.assertIn("does not belong", self.parent_registry()[0]["lastError"])

    def test_a_machine_removed_from_the_config_is_refused(self):
        self.write_config({})
        rc, out, err = self.send("hello")
        self.assertEqual(rc, 1)
        self.assertIn("[machine_not_allowed]", err)

    def test_a_local_entry_still_goes_through_intercom(self):
        reg = self.padir / "pi-foreman" / "state" / "sessions.json"
        data = json.loads(reg.read_text("utf-8"))
        loc = self.tmp / "loc-handoff"
        loc.mkdir()
        data["sessions"].append({"label": "loc", "child": "fm-loc-abc123", "parent": "p", "handoff": str(loc), "status": "open"})
        reg.write_text(json.dumps(data), "utf-8")
        sent = []
        with mock.patch.object(fsn, "send_intercom", side_effect=lambda to, text: (sent.append((to, text)), (True, ""))[1]):
            rc, out, err = self.run_main("brief", "loc", "hi there", "--parent-id", PARENT)
        self.assertEqual((rc, sent), (0, [("fm-loc-abc123", "Brief from %s: read %s and act on it" % (PARENT, (loc / "brief-1.md").resolve().as_posix()))]))
        self.assertEqual((loc / "brief-1.md").read_text("utf-8"), "hi there\n")


class NoticeBase(RemoteBase):
    def setUp(self):
        super().setUp()
        self.reply = self.remote_open()
        self.dir = self.handoff(self.reply)
        self.child = self.reply["child"]
        self.env.update(PI_CODING_AGENT_DIR=str(self.radir), PI_FOREMAN_REMOTE_PARENT="1", PI_FOREMAN_HANDOFF_DIR=str(self.dir),
                        HC_TERMINAL_ID="t1")

    def notice(self, *args, **env):
        code, out, err = self.run_main("remote", "notice", *args, **env)
        return code, json.loads(out)

    def sent(self):
        return lines_of(self.logs["node"])


class NoticeTest(NoticeBase):
    """The child-side `remote notice` checks its input, then sets the `fm.notice` label on its own hc terminal."""

    def test_a_valid_notice_sets_the_label(self):
        (self.dir / "result.md").write_text("done", "utf-8")
        (self.dir / "plan.md").write_text("plan", "utf-8")
        (self.dir / "ask.md").write_text("# Ask 1: x", "utf-8")
        for n, args in enumerate((("result",), ("plan",), ("ask",), ("update",), ("closed", "--close", "ready"), ("closed",)), 1):
            code, r = self.notice(*args)
            self.assertEqual((code, r["ok"], r["seq"]), (0, True, n), args)
        self.assertEqual(self.sent(), [])
        self.assertEqual(len(self.hc_calls("label")), 6)

    def test_no_entry(self):
        (self.dir / "child").write_text("fm-other-000000\n", "utf-8")
        code, r = self.notice("closed")
        self.assertEqual((code, r["code"]), (1, "no_entry"))
        (self.dir / "child").unlink()
        self.assertEqual(self.notice("closed")[1]["code"], "no_entry")

    def test_bad_name(self):
        (self.dir / "result.md").write_text("r", "utf-8")
        (self.dir / "other.md").write_text("o", "utf-8")
        for args in (("result", "other.md"), ("result", str(self.dir / "other.md")), ("result", "../result.md"),
                     ("plan", "result.md"), ("ask", str(self.tmp / "ask.md")), ("plan",)):
            code, r = self.notice(*args)
            self.assertEqual((code, r["code"]), (1, "bad_name"), args)  # ("plan",): plan.md does not exist

    @unittest.skipIf(sys.platform == "win32", "symlinks need privileges on win32")
    def test_symlinked_file_is_refused(self):
        (self.tmp / "secret.txt").write_text("secret", "utf-8")
        (self.dir / "result.md").symlink_to(self.tmp / "secret.txt")
        code, r = self.notice("result")
        self.assertEqual((code, r["code"]), (1, "bad_name"))

    def test_bad_parent_file(self):
        (self.dir / "result.md").write_text("r", "utf-8")
        for text in ("xyz", PARENT, PARENT + "@-x", PARENT + "@a b", "@beta"):
            (self.dir / "parent").write_text(text + "\n", "utf-8")
            code, r = self.notice("result")
            self.assertEqual((code, r["code"]), (1, "bad_parent"), text)

    def test_needs_the_remote_parent_environment(self):
        (self.dir / "result.md").write_text("r", "utf-8")
        self.assertEqual(self.notice("result", PI_FOREMAN_REMOTE_PARENT="")[1]["code"], "not_remote")
        self.assertEqual(self.notice("result", PI_FOREMAN_HANDOFF_DIR="")[1]["code"], "no_handoff")

    def test_usage_errors(self):
        self.assertEqual(self.run_main("remote", "notice", "bogus")[0], 1)
        self.assertEqual(self.run_main("remote", "notice", "closed", "--close", "maybe")[0], 1)

    def test_footer_commands_run_through_main(self):
        brief = (self.dir / "brief.md").read_text("utf-8")
        cmds = [l.strip() for l in brief.splitlines() if " remote notice " in l and l.startswith("   ")]
        self.assertEqual([shlex.split(c)[shlex.split(c).index("notice") + 1] for c in cmds], ["result", "update", "closed", "ask"])
        by_kind = {shlex.split(c)[shlex.split(c).index("notice") + 1]: shlex.split(c) for c in cmds}
        argv = by_kind["result"]
        self.assertEqual(argv[1:3], ["-E", "-s"])
        self.assertEqual(Path(argv[3]), Path(fsn.__file__).resolve())
        self.assertNotIn("session", argv)
        (self.dir / "result.md").write_text("from the footer", "utf-8")
        rc, out, err = self.run_main(*argv[4:], HC_TERMINAL_ID="t1")
        self.assertEqual(rc, 0, out)
        self.assertEqual(json.loads(out)["seq"], 1)


class NoticeLabelTest(NoticeBase):
    """The label grammar: `fm.notice=<seq>:<kind>:<sha256>:<bytes>`, `fm.close=ready|open`, `fm.notice=<seq>:refused:<slug>`."""

    def labels(self):
        return [c[1:] for c in self.hc_calls("label")]

    def sha(self, text):
        return hashlib.sha256(text.encode("utf-8")).hexdigest(), len(text.encode("utf-8"))

    def test_file_kinds(self):
        for name, text in (("plan.md", "plan \u6f22"), ("result.md", "done\n"), ("ask.md", "# Ask 1: x")):
            (self.dir / name).write_text(text, "utf-8")
        sha = {n: self.sha((self.dir / n).read_text("utf-8")) for n in ("plan.md", "result.md", "ask.md")}
        out = []
        for kind, name in (("plan", "plan.md"), ("result", "result.md"), ("update", "result.md"), ("ask", "ask.md")):
            code, r = self.notice(kind)
            out.append(r)
            want = "%d:%s:%s:%d" % (len(out), kind, sha[name][0], sha[name][1])
            self.assertEqual((code, r), (0, {"ok": True, "seq": len(out), "label": want}))
        self.assertEqual(self.labels(), [["t1", "fm.notice=" + r["label"]] for r in out])
        self.assertEqual(self.notice("result")[1]["seq"], 5)

    def test_json_line_on_stdout(self):
        (self.dir / "result.md").write_text("r", "utf-8")
        code, out, err = self.run_main("remote", "notice", "result")
        self.assertEqual(len(out.splitlines()), 1)
        self.assertEqual(sorted(json.loads(out)), ["label", "ok", "seq"])

    def test_seq_counts_up_and_starts_at_one_without_the_file(self):
        (self.dir / "result.md").write_text("r", "utf-8")
        self.assertFalse((self.dir / "notice-seq").exists())
        self.assertEqual(self.notice("result")[1]["seq"], 1)
        self.assertEqual(self.notice("result")[1]["seq"], 2)
        self.assertEqual((self.dir / "notice-seq").read_text("utf-8").strip(), "2")
        (self.dir / "notice-seq").unlink()
        self.assertEqual(self.notice("result")[1]["seq"], 1)
        (self.dir / "notice-seq").write_text("junk\n", "utf-8")
        self.assertEqual(self.notice("result")[1]["seq"], 1)

    def test_closed_with_and_without_a_result(self):
        code, r = self.notice("closed")
        self.assertEqual((code, r["label"]), (0, "1:closed:-:0"))
        code, r = self.notice("closed", "--close", "open")
        self.assertEqual(r["label"], "2:closed:-:0")
        (self.dir / "result.md").write_text("final", "utf-8")
        sha, size = self.sha("final")
        code, r = self.notice("closed", "--close", "ready")
        self.assertEqual((code, r["label"]), (0, "3:closed:%s:%d" % (sha, size)))
        self.assertEqual(self.labels(), [["t1", "fm.notice=1:closed:-:0"], ["t1", "fm.notice=2:closed:-:0", "fm.close=open"],
                                         ["t1", "fm.notice=3:closed:%s:%d" % (sha, size), "fm.close=ready"]])

    def test_refused_slug(self):
        code, r = self.notice("refused", "--reason", "uncommitted-work")
        self.assertEqual((code, r), (0, {"ok": True, "seq": 1, "label": "1:refused:uncommitted-work"}))
        self.assertEqual(self.labels(), [["t1", "fm.notice=1:refused:uncommitted-work"]])
        for bad in (None, "", "Upper", "has space", "semi;colon", "a:b", "x" * 41):
            args = ("refused",) + (("--reason", bad) if bad is not None else ())
            code, r = self.notice(*args)
            self.assertEqual((code, r["code"]), (1, "bad_request"), bad)
        self.assertEqual(len(self.labels()), 1)
        self.assertEqual(self.notice("refused", "--reason", "x" * 40)[0], 0)

    def test_failure_replies_share_one_shape(self):
        (self.dir / "result.md").write_text("r", "utf-8")
        code, r = self.notice("refused", "--reason", "Not A Slug")
        self.assertEqual((code, r["ok"], r["error"], r["code"]), (1, False, "bad_request", "bad_request"))
        self.assertIn("detail", r)
        code, r = self.notice("result", HC_TERMINAL_ID="")
        self.assertEqual((code, r["ok"], r["error"]), (1, False, "not_hc"))

    def test_notice_seq_is_locked_and_unique_under_parallel_callers(self):
        import threading
        got = []
        errors = []

        def take():
            try:
                got.append(fsn.next_notice_seq(self.dir))
            except Exception as e:  # noqa: BLE001
                errors.append(e)

        threads = [threading.Thread(target=take) for _ in range(12)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual((errors, sorted(got)), ([], list(range(1, 13))))
        self.assertFalse((self.dir / "notice-seq.lock").exists())
        self.assertEqual((self.dir / "notice-seq").read_text("utf-8").strip(), "12")

    def test_a_stale_notice_seq_lock_is_broken(self):
        lock = self.dir / "notice-seq.lock"
        lock.write_text("", "utf-8")
        old = time.time() - 60
        os.utime(str(lock), (old, old))
        self.assertEqual(fsn.next_notice_seq(self.dir), 1)
        self.assertFalse(lock.exists())

    def test_not_hc(self):
        (self.dir / "result.md").write_text("r", "utf-8")
        for env in ({"HC_TERMINAL_ID": ""}, {"PATH": self.path(hc=False)}):
            code, r = self.notice("result", **env)
            self.assertEqual((code, r), (1, {"ok": False, "error": "not_hc"}))
        self.assertEqual(self.hc_calls("label"), [])
        self.assertFalse((self.dir / "notice-seq").exists())

    def test_hc_bin_names_the_binary(self):
        (self.dir / "result.md").write_text("r", "utf-8")
        real = shutil.which("hc", path=str(self.hcbin))
        code, r = self.notice("result", PATH=self.path(hc=False), HC_BIN=real)
        self.assertEqual((code, r["ok"]), (0, True))

    def test_label_failed(self):
        (self.dir / "result.md").write_text("r", "utf-8")
        code, r = self.notice("result", FAKE_HC_FAIL="1")
        self.assertEqual((code, r), (1, {"ok": False, "error": "label_failed", "detail": "boom"}))

    def test_label_failed_when_hc_cannot_be_spawned(self):
        (self.dir / "result.md").write_text("r", "utf-8")
        with mock.patch.object(fsn.subprocess, "run", side_effect=OSError("gone\x1b[2J")):
            code, r = self.notice("result")
        self.assertEqual((code, r["error"], r["detail"]), (1, "label_failed", "gone[2J"))


class ControlTextOfOpenTest(RemoteBase):
    """The handoff path and the launch command of an `open` reply reach the terminal without control characters."""

    def open_with(self, **over):
        real = fsn.hc_exec_verb

        def dirty(binary, name, argv, verb, payload, timeout):
            reply = real(binary, name, argv, verb, payload, timeout)
            return dict(reply, **over) if verb == "open" else reply

        with mock.patch.object(fsn, "hc_exec_verb", side_effect=dirty):
            return self.run_main(*self.open_args())

    def test_handoff_is_stripped(self):
        rc, out, err = self.open_with(handoff="/h\x1b[2Jx\x07/y")
        self.assertEqual(rc, 0, err)
        self.assertIn("handoff on alpha: /h[2Jx/y\n", out)
        self.assertNotIn("\x1b", out)

    def test_launch_is_stripped(self):
        rc, out, err = self.open_with(status="pending", launch="pi \x1b]0;t\x07go\x9b")
        self.assertEqual(rc, 0, err)
        self.assertIn("pi ]0;tgo", out)
        for ch in ("\x1b", "\x07", "\x9b"):
            self.assertNotIn(ch, out)


class FooterTest(unittest.TestCase):
    def commands(self, plan_first):
        text = fsn.remote_footer("demo", plan_first)
        return text, [l.strip() for l in text.splitlines() if " remote notice" in l]

    def test_footer_forms(self):
        for plan_first in (False, True):
            text, cmds = self.commands(plan_first)
            self.assertTrue(cmds)
            for c in cmds:
                self.assertNotIn("\\", c)
                self.assertNotIn("&", c)
                self.assertNotIn("session remote", c)
                self.assertNotIn("\n", c)
            self.assertEqual(any(c.endswith(" plan") for c in cmds), plan_first)
            self.assertIn("ruling-<n>.md", text)
            self.assertEqual("`ruling.md`" in text, plan_first)
            for gone in ("outbox", "bytes (", "owner closes this pane"):
                self.assertNotIn(gone, text)

    def test_each_command_is_one_line_and_valid_under_bash(self):
        bash = shutil.which("bash")
        if sys.platform == "win32" or not bash:
            self.skipTest("bash syntax check is for POSIX hosts")
        for plan_first in (False, True):
            _, cmds = self.commands(plan_first)
            for c in cmds:
                r = subprocess.run([bash, "-n", "-c", c], capture_output=True)
                self.assertEqual(r.returncode, 0, (c, r.stderr))

    def test_the_interpreter_is_quoted_when_its_path_has_a_space(self):
        with mock.patch.object(fsn.sys, "executable", "/opt/my python/bin/python3"):
            _, cmds = self.commands(False)
        self.assertTrue(all(c.startswith("'/opt/my python/bin/python3' -E -s ") for c in cmds), cmds)


class RemoteOptionTest(RemoteBase):
    def test_unsupported_flags_are_refused_with_machine(self):
        rc, out, err = self.run_main(*self.open_args("--print-all"))
        self.assertEqual(rc, 1)
        self.assertIn("[remote_option]", err)
        self.assertIn("--print-all is not supported with --machine", err)
        self.assertEqual(self.hc_calls("machine", "exec", "run"), [])
        self.assertEqual(self.parent_registry(), [])
        self.assertFalse((self.padir / "pi-foreman").exists())
        self.assertFalse((self.radir / "pi-foreman").exists())

    def test_local_open_with_plan_mode_still_works(self):
        rc, out, err = self.run_main("open", "demo", str(self.brief), "--cwd", str(self.rproj), "--parent-id", PARENT,
                                     "--plan-mode", "--dry-run")
        self.assertEqual(rc, 0, err)
        # the dry-run line is PowerShell on win32, where every message is single-quoted
        self.assertIn("pi '/plan Read the handoff", out)
        self.assertEqual(self.hc_calls("machine", "exec"), [])


class TrailingNewlineTest(unittest.TestCase):
    def test_validation_patterns_refuse_a_trailing_newline(self):
        ok = {"MACHINE_RE": "alpha", "ADDRESS_RE": ADDRESS, "ARGV_WORD_RE": "foreman",
              "HANDOFF_NAME_RE": "20261024-120000-demo", "LABEL_RE": "demo", "VALUE_RE": "model-1"}
        for name, value in ok.items():
            rx = getattr(fsn, name)
            self.assertTrue(rx.match(value), name)
            self.assertIsNone(rx.match(value + "\n"), name)
        for kind, value in ("ruling", "ruling.md"), ("ruling", "ruling-plan.md"), ("ruling", "ruling-2.md"), \
                ("steer", "steer-1.md"), ("brief", "brief-3.md"):
            self.assertTrue(fsn.DELIVER_NAMES[kind].match(value), value)
            self.assertIsNone(fsn.DELIVER_NAMES[kind].match(value + "\n"), value)

    def test_machine_keys_with_a_trailing_newline_are_refused(self):
        self.assertEqual(fc.machine_issues({"alpha": {}}), [])
        self.assertEqual(len(fc.machine_issues({"alpha\n": {}})), 1)


if __name__ == "__main__":
    unittest.main()
