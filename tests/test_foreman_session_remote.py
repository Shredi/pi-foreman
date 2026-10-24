"""Remote child sessions (scripts/foreman_session.py): the config, the remote verbs probe/open/deliver/notice and the parent CLI.

Only fakes: a fake `ssh` (runs the remote verb in a second process against a second agent dir), a fake `herdr`
(saved machines, agent list, server up/down) and a fake `node` for pi-intercom's CLI. Machine names are alpha and beta.
The fake binaries are POSIX scripts, so the tests that need them are skipped on win32; the win32 cases are covered by
tests that patch the platform.
"""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TESTS = Path(__file__).resolve().parent
SCRIPTS = TESTS.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(TESTS))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_config as fc  # noqa: E402
import foreman_session as fsn  # noqa: E402
import foreman_trust  # noqa: E402

PARENT = "11111111-2222-3333-4444-555555555555"
OTHER = "99999999-8888-7777-6666-555555555555"
ADDRESS = PARENT + "@beta"
PARENT_MACHINES = [{"label": "alpha", "target": "alpha-host", "enabled": True},
                   {"label": "beta", "target": "beta-host", "enabled": False},
                   {"label": "gamma", "target": "gamma-host", "enabled": True}]
REMOTE_MACHINES = [{"label": "beta", "target": "beta-host", "enabled": True}]


def pi_row(uuid):
    return {"agent": "pi", "agent_session": {"kind": "path", "value": "/s/2026-01-01T00-00-00_%s.jsonl" % uuid}}


REMOTE_AGENTS = [pi_row(PARENT), {"agent": "shell"}, pi_row(OTHER)]

FAKE_SSH = r'''
import io, json, os, sys, time
argv = sys.argv[1:]
data = sys.stdin.buffer.read()
with open(os.environ["FAKE_SSH_LOG"], "a", encoding="utf-8") as f:
    f.write(json.dumps({"argv": argv, "stdin": data.decode("utf-8")}) + "\n")
mode = os.environ.get("FAKE_SSH_MODE", "ok")
if mode == "255":
    sys.stderr.write("ssh: connect to host alpha-host port 22: Connection refused\n")
    sys.exit(255)
if mode == "timeout":
    time.sleep(30)
if mode == "nonjson":
    print("not json at all")
    sys.exit(0)
words = argv[-1].split()
verb = words[words.index("remote") + 1]
if mode == "banner":
    print("Welcome to alpha-host")
os.environ["PI_CODING_AGENT_DIR"] = os.environ["FAKE_REMOTE_AGENT"]
os.environ["FAKE_HERDR_MACHINES"] = os.environ.get("FAKE_REMOTE_HERDR_MACHINES", "[]")
os.environ["FAKE_HERDR_AGENTS"] = os.environ.get("FAKE_REMOTE_HERDR_AGENTS", "[]")
os.environ.pop("FAKE_HERDR_DOWN", None)
if os.environ.get("FAKE_REMOTE_HERDR_DOWN"):
    os.environ["FAKE_HERDR_DOWN"] = "1"
os.environ.pop("HERDR_PANE_ID", None)
if os.environ.get("FAKE_REMOTE_PATH"):
    os.environ["PATH"] = os.environ["FAKE_REMOTE_PATH"]
sys.path.insert(0, os.environ["FAKE_SCRIPTS"])
import foreman_session as fsn
from pathlib import Path
fsn.intercom_cli = (lambda: None) if os.environ.get("FAKE_NO_INTERCOM") else (lambda: Path(os.environ["FAKE_CLI"]))
if os.environ.get("FAKE_SSH_PROTOCOL"):
    fsn.REMOTE_PROTOCOL = int(os.environ["FAKE_SSH_PROTOCOL"])
sys.stdin = io.TextIOWrapper(io.BytesIO(data), encoding="utf-8")
sys.exit(fsn.main(["remote", verb, "--json"]))
'''

FAKE_HERDR = r'''
import json, os, sys
args = sys.argv[1:]
with open(os.environ["FAKE_HERDR_LOG"], "a", encoding="utf-8") as f:
    f.write(json.dumps(args) + "\n")
if args[:2] == ["workspace", "list"] and os.environ.get("FAKE_HERDR_DOWN"):
    sys.stderr.write("no server\n")
    sys.exit(1)
if args[:3] == ["machine", "list", "--json"]:
    out = {"result": {"machines": json.loads(os.environ.get("FAKE_HERDR_MACHINES", "[]"))}}
elif args[:1] == ["--machine"] and args[2:4] == ["agent", "list"]:
    out = {"result": {"agents": json.loads(os.environ.get("FAKE_HERDR_AGENTS", "[]"))}}
elif args[:2] == ["workspace", "list"]:
    out = {"result": {"workspaces": []}}
elif args[:2] == ["workspace", "create"]:
    out = {"result": {"workspace": {"workspace_id": "w9"}, "tab": {"tab_id": "w9:t1"}, "root_pane": {"pane_id": "w9:p1"}}}
else:
    out = {"result": {}}
print(json.dumps(out))
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


posix_only = unittest.skipIf(sys.platform == "win32", "fake ssh, herdr and node are POSIX scripts")


class RemoteBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="session_remote_")).resolve()
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.padir = self.tmp / "parent agent"
        self.radir = self.tmp / "remote agent"
        self.rproj = self.tmp / "remote proj"
        self.rproj.mkdir()
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.pibin = self.tmp / "pibin"
        self.pibin.mkdir()
        for name, body in (("ssh", FAKE_SSH), ("herdr", FAKE_HERDR), ("node", FAKE_NODE)):
            self.script(self.bin / name, body)
        self.script(self.pibin / "pi", "print('pi 9.9.9')\n")
        cli = self.radir / "npm" / "node_modules" / "pi-intercom"
        cli.mkdir(parents=True)
        (cli / "cli.mjs").write_text("// fake\n", "utf-8")
        (cli / "package.json").write_text('{"version": "1.2.3"}', "utf-8")
        self.cli = cli / "cli.mjs"
        self.brief = self.tmp / "brief.md"
        self.brief.write_text("# Task\n\nDo the thing.\n", "utf-8")
        self.logs = {k: self.tmp / (k + ".log") for k in ("ssh", "herdr", "node")}
        self.write_config({"alpha": {"parentName": "beta"}, "beta": {}, "gamma": {}})
        self.env = {"PATH": os.pathsep.join([str(self.bin), str(self.pibin), os.environ.get("PATH", "")]),
                    "PI_CODING_AGENT_DIR": str(self.padir), "HERDR_PANE_ID": "w1:p1",
                    "FAKE_SSH_LOG": str(self.logs["ssh"]), "FAKE_HERDR_LOG": str(self.logs["herdr"]),
                    "FAKE_NODE_LOG": str(self.logs["node"]), "FAKE_SCRIPTS": str(SCRIPTS), "FAKE_CLI": str(self.cli),
                    "FAKE_REMOTE_AGENT": str(self.radir), "FAKE_HERDR_MACHINES": json.dumps(PARENT_MACHINES),
                    "FAKE_REMOTE_HERDR_MACHINES": json.dumps(REMOTE_MACHINES),
                    "FAKE_REMOTE_HERDR_AGENTS": json.dumps(REMOTE_AGENTS)}
        for k in ("HERDR_BIN", "HERDR_BIN_PATH", "PI_INTERCOM_STABLE_ID", "PI_INTERCOM_SESSION_ID", "PI_FOREMAN_HANDOFF_DIR",
                  "PI_FOREMAN_REMOTE_PARENT", "PI_FOREMAN_SESSION_MODEL", "FAKE_SSH_MODE", "FAKE_REMOTE_PATH",
                  "FAKE_NO_INTERCOM", "FAKE_SSH_PROTOCOL", "FAKE_HERDR_DOWN", "FAKE_REMOTE_HERDR_DOWN", "FAKE_NODE_EXIT"):
            self.env[k] = ""
        for k in os.environ:
            if k.startswith("PI_BG_"):
                self.env[k] = ""

    def script(self, path, body):
        path.write_text("#!%s\n%s" % (sys.executable, body), "utf-8")
        path.chmod(0o755)

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
        renv = {"PI_CODING_AGENT_DIR": str(self.radir), "HERDR_PANE_ID": "", "FAKE_HERDR_MACHINES": json.dumps(REMOTE_MACHINES),
                "FAKE_HERDR_AGENTS": json.dumps(REMOTE_AGENTS)}
        renv.update(env)
        code, out, err = self.run_main("remote", verb, "--json", stdin=stdin, **renv)
        reply = json.loads(out.strip().splitlines()[-1])
        return code, reply

    def open_args(self, *extra, machine="alpha", cwd=None, parent=PARENT):
        args = ["open", "demo", str(self.brief), "--machine", machine, "--cwd", str(cwd or self.rproj)]
        if parent:
            args += ["--parent-id", parent]
        return tuple(args) + extra

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
        self.assertEqual(sessions, {"machines": {}, "remoteInlineMaxBytes": 32768})

    def test_machines_from_the_project_layer_are_ignored(self):
        r = self.load(project={"sessions": {"machines": {"alpha": {}}}}, l2={"sessions": {"machines": {"beta": {}}}})
        self.assertEqual(list(r["config"]["sessions"]["machines"]), ["beta"])
        self.assertTrue(any("sessions.machines" in w for w in r["warnings"]), r["warnings"])

    def test_inline_max_bytes_is_lower_only_with_a_minimum(self):
        self.assertEqual(self.load(project={"sessions": {"remoteInlineMaxBytes": 4096}})["config"]["sessions"]["remoteInlineMaxBytes"], 4096)
        self.assertEqual(self.load(project={"sessions": {"remoteInlineMaxBytes": 40000}})["config"]["sessions"]["remoteInlineMaxBytes"], 32768)
        r = self.load(project={"sessions": {"remoteInlineMaxBytes": 10}})
        self.assertEqual(r["config"]["sessions"]["remoteInlineMaxBytes"], 32768)
        self.assertEqual(r["errors"], [])

    def test_schema_bounds_and_patterns(self):
        ok = {"sessions": {"machines": {"alpha": {"foremanCommand": "/opt/fm/bin/foreman", "parentName": "beta"}},
                           "remoteInlineMaxBytes": 49152}}
        self.assertEqual(self.issues(ok), [])
        for bad in ({"sessions": {"remoteInlineMaxBytes": 1023}}, {"sessions": {"remoteInlineMaxBytes": 49153}},
                    {"sessions": {"machines": {"alpha": {"foremanCommand": "-oProxyCommand=x"}}}},
                    {"sessions": {"machines": {"alpha": {"foremanCommand": "a b"}}}},
                    {"sessions": {"machines": {"alpha": {"parentName": "-x"}}}},
                    {"sessions": {"machines": {"-alpha": {}}}}, {"sessions": {"machines": {"a b": {}}}},
                    {"sessions": {"machines": {"alpha": {"unknown": 1}}}}):
            self.assertTrue(self.issues(bad), bad)

    def test_remote_sessions_feature_follows_machines(self):
        import foreman_docs as fd
        feature = next(f for f in fd.load_features()["features"] if f["id"] == "remote-sessions")
        self.assertFalse(fd.switch_on(feature, self.load()["config"]))
        self.assertTrue(fd.switch_on(feature, self.load(l2={"sessions": {"machines": {"alpha": {}}}})["config"]))


@posix_only
class ProbeTest(RemoteBase):
    def probe(self, **env):
        return self.remote("probe", {"parentName": "beta", "parentAddress": ADDRESS}, **env)

    def test_probe_fields(self):
        code, r = self.probe()
        self.assertEqual(code, 0)
        self.assertEqual(r["protocol"], 1)
        self.assertEqual((r["piVersion"], r["intercomVersion"], r["platform"]), ("pi 9.9.9", "1.2.3", sys.platform))
        self.assertEqual(r["herdr"], {"available": True, "serverUp": True})
        self.assertEqual((r["agentDir"], r["returnPath"]), (str(self.radir), True))
        self.assertIn("foremanVersion", r)
        self.assertEqual(r["intercomMachine"], fsn.short_hostname())

    def test_intercom_machine_name_comes_from_the_intercom_config(self):
        (self.radir / "intercom").mkdir()
        (self.radir / "intercom" / "config.json").write_text(json.dumps({"crossMachine": {"machineName": " beta "}}), "utf-8")
        self.assertEqual(self.probe()[1]["intercomMachine"], "beta")

    def test_server_down(self):
        self.assertEqual(self.probe(FAKE_HERDR_DOWN="1")[1]["herdr"], {"available": True, "serverUp": False})

    def test_return_path_needs_the_parent_saved_and_enabled(self):
        off = [dict(REMOTE_MACHINES[0], enabled=False)]
        r = self.probe(FAKE_HERDR_MACHINES=json.dumps(off))[1]
        self.assertFalse(r["returnPath"])
        self.assertIn("beta", r["returnPathError"])
        self.assertFalse(self.probe(FAKE_HERDR_MACHINES="[]")[1]["returnPath"])

    def test_return_path_needs_exactly_one_agent_with_the_parent_uuid(self):
        self.assertFalse(self.probe(FAKE_HERDR_AGENTS=json.dumps([pi_row(OTHER)]))[1]["returnPath"])
        two = self.probe(FAKE_HERDR_AGENTS=json.dumps([pi_row(PARENT), pi_row(PARENT)]))[1]
        self.assertFalse(two["returnPath"])
        self.assertIn("2 pi agents", two["returnPathError"])

    def test_return_path_reads_pi_rows_with_a_session_file_only(self):
        rows = [{"agent": "shell", "agent_session": {"kind": "path", "value": "/s/x_%s.jsonl" % PARENT}},
                {"agent": "pi", "agent_session": {"kind": "name", "value": "x_%s.jsonl" % PARENT}},
                {"agent": "pi", "agent_session": {"kind": "path", "value": "/s/%s.jsonl" % PARENT}}]
        self.assertFalse(self.probe(FAKE_HERDR_AGENTS=json.dumps(rows))[1]["returnPath"])
        letters = "abcdefab-cdef-abcd-efab-cdefabcdefab"
        asked = {"parentName": "beta", "parentAddress": letters + "@beta"}
        for row, expected in ((pi_row(letters), True), (pi_row(letters.upper()), False)):  # ids compare exactly
            reply = self.remote("probe", asked, FAKE_HERDR_AGENTS=json.dumps([row]))[1]
            self.assertEqual(reply["returnPath"], expected)

    def test_herdr_bin_path_rule(self):
        r = self.probe(HERDR_BIN_PATH=str(self.tmp / "missing herdr"))[1]
        self.assertFalse(r["returnPath"])
        self.assertIn("not found", r["returnPathError"])
        other = self.tmp / "herdr2"
        self.script(other, FAKE_HERDR)
        self.assertTrue(self.probe(HERDR_BIN_PATH=str(other))[1]["returnPath"])

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


class Win32LaunchTest(RemoteBase):
    def test_win32_launch_line_is_the_powershell_form(self):
        with mock.patch.object(fsn, "host_platform", return_value="win32"), mock.patch.object(fsn, "herdr_bin", return_value=None):
            code, reply = self.remote("open", self.open_params())
        self.assertEqual(code, 0)
        self.assertEqual(reply["status"], "pending")
        self.assertTrue(reply["launch"].startswith("$env:PI_FOREMAN_HANDOFF_DIR="), reply["launch"])
        self.assertIn("$env:PI_FOREMAN_REMOTE_PARENT='1'", reply["launch"])
        self.assertEqual((self.handoff(reply) / "launch.txt").read_text("utf-8").strip(), reply["launch"])


@posix_only
class RemoteOpenTest(RemoteBase):
    def test_open_writes_the_remote_handoff(self):
        reply = self.remote_open()
        h = self.handoff(reply)
        self.assertEqual(reply["status"], "open")
        self.assertEqual(reply["herdr"], {"workspace": "w9", "tab": "w9:t1", "pane": "w9:p1"})
        self.assertRegex(reply["handoffName"], r"^\d{8}-\d{6}-demo$")
        self.assertEqual((h / "parent").read_text("utf-8").strip(), ADDRESS)
        self.assertEqual((h / "child").read_text("utf-8").strip(), reply["child"])
        brief = (h / "brief.md").read_text("utf-8")
        self.assertIn("remote notice", brief)
        self.assertIn("pi-foreman remote session `demo`", brief)
        launch = (h / "launch.txt").read_text("utf-8")
        self.assertIn("PI_FOREMAN_REMOTE_PARENT=1", launch)
        self.assertIn("PI_FOREMAN_PARENT_LABEL=beta", launch)
        self.assertIn("PI_FOREMAN_PARENT_INTERCOM=%s" % ADDRESS, launch)
        entry = self.remote_registry()[0]
        self.assertEqual((entry["child"], entry["parent"], entry["status"]), (reply["child"], ADDRESS, "open"))
        pane_run = [c for c in lines_of(self.logs["herdr"]) if c[:2] == ["pane", "run"]]
        self.assertEqual(len(pane_run), 1)
        self.assertIn("PI_FOREMAN_REMOTE_PARENT=1", pane_run[0][3])

    def test_open_stdout_is_exactly_one_json_line(self):
        _, out, _ = self.run_main("remote", "open", "--json", stdin=json.dumps(self.open_params()).encode("utf-8"),
                                  PI_CODING_AGENT_DIR=str(self.radir), HERDR_PANE_ID="")
        self.assertEqual(len(out.strip().splitlines()), 1)
        self.assertTrue(json.loads(out)["ok"])

    def test_without_a_herdr_server_the_session_is_pending_with_a_launch_line(self):
        code, reply = self.remote("open", self.open_params(), FAKE_HERDR_DOWN="1")
        self.assertEqual((code, reply["status"], reply["herdr"] if "herdr" in reply else None), (0, "pending", None))
        self.assertTrue(reply["launch"].startswith("env "), reply["launch"])
        self.assertEqual((self.handoff(reply) / "launch.txt").read_text("utf-8").strip(), reply["launch"])
        self.assertEqual(self.remote_registry()[0]["status"], "pending")

    def test_dry_run_writes_nothing(self):
        code, reply = self.remote("open", self.open_params(dryRun=True))
        self.assertEqual((code, reply["status"]), (0, "dryRun"))
        self.assertFalse((self.radir / "pi-foreman").exists())
        self.assertEqual([c for c in lines_of(self.logs["herdr"]) if c[0] in ("tab", "pane", "workspace") and c[1] != "list"], [])

    def test_refusals(self):
        cases = [({"extra": 1}, "bad_request"), ({"label": "-bad"}, "bad_request"), ({"model": "a b"}, "bad_request"),
                 ({"parentAddress": "x@beta"}, "bad_request"), ({"parentAddress": PARENT + "@alpha"}, "bad_request"),
                 ({"cwd": str(self.tmp / "nowhere")}, "bad_cwd"), ({"cwd": str(self.tmp / "a;b")}, "refused"),
                 ({"brief": "x" * (64 * 1024 + 1)}, "too_large"), ({"planFirst": "yes"}, "bad_request")]
        for over, code in cases:
            rc, reply = self.remote("open", self.open_params(**over))
            self.assertEqual((rc, reply["ok"], reply["code"]), (1, False, code), over)
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


@posix_only
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


@posix_only
class ParentTest(RemoteBase):
    def ssh_calls(self):
        return lines_of(self.logs["ssh"])

    def refused(self, *args, code, **env):
        rc, out, err = self.run_main(*args, **env)
        self.assertEqual(rc, 1, (out, err))
        self.assertIn("[%s]" % code, err)
        self.assertEqual(self.parent_registry(), [])
        return err

    def test_open_success(self):
        rc, out, err = self.run_main(*self.open_args())
        self.assertEqual(rc, 0, err)
        entry = self.parent_registry()[0]
        calls = self.ssh_calls()
        self.assertEqual([c["argv"][-1] for c in calls], ["foreman session remote probe --json",
                                                           "foreman session remote open --json"])
        self.assertEqual(calls[0]["argv"][:5], ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "alpha-host"])
        self.assertEqual(json.loads(calls[0]["stdin"]), {"parentName": "beta", "parentAddress": ADDRESS})
        sent = json.loads(calls[1]["stdin"])
        self.assertEqual((sent["label"], sent["cwd"], sent["parentAddress"], sent["trust"], sent["dryRun"]),
                         ("demo", str(self.rproj), ADDRESS, False, False))
        self.assertEqual(sent["brief"], self.brief.read_text("utf-8"))
        handoff_name = entry["handoffName"]
        mirror = self.padir / "pi-foreman" / "remote" / "alpha" / handoff_name
        self.assertEqual({k: entry[k] for k in ("label", "parent", "parentAddress", "machine", "originMachine", "handoffName",
                                                "mirror", "handoff", "status", "lastError", "briefs", "last", "cwd")},
                         {"label": "demo", "parent": PARENT, "parentAddress": ADDRESS, "machine": "alpha",
                          "originMachine": fsn.short_hostname(), "handoffName": handoff_name, "mirror": str(mirror),
                          "handoff": str(mirror), "status": "open", "lastError": None, "briefs": 0, "last": None,
                          "cwd": str(self.rproj)})
        self.assertEqual(entry["remoteHandoff"], str(self.radir / "pi-foreman" / "handoffs" / handoff_name))
        self.assertEqual((entry["remote"]["protocol"], entry["remote"]["piVersion"], entry["remote"]["platform"]),
                         (1, "pi 9.9.9", sys.platform))
        self.assertTrue(mirror.is_dir() and not list(mirror.iterdir()))
        remote_entry = self.remote_registry()[0]
        self.assertEqual((remote_entry["child"], remote_entry["parent"]), (entry["child"], ADDRESS))
        self.assertTrue((Path(entry["remoteHandoff"]) / "brief.md").is_file())
        self.assertIn("alpha", out)

    def test_custom_foreman_command(self):
        self.write_config({"alpha": {"parentName": "beta", "foremanCommand": "/opt/fm/bin/foreman"}})
        self.assertEqual(self.run_main(*self.open_args())[0], 0)
        self.assertEqual([c["argv"][-1] for c in self.ssh_calls()],
                         ["/opt/fm/bin/foreman session remote probe --json", "/opt/fm/bin/foreman session remote open --json"])

    def test_parent_name_falls_back_to_the_intercom_config(self):
        self.write_config({"alpha": {}})
        (self.padir / "intercom").mkdir()
        (self.padir / "intercom" / "config.json").write_text(json.dumps({"crossMachine": {"machineName": "beta"}}), "utf-8")
        self.assertEqual(self.run_main(*self.open_args())[0], 0)
        self.assertEqual(json.loads(self.ssh_calls()[0]["stdin"])["parentName"], "beta")

    def test_ssh_banner_line_before_the_json(self):
        self.assertEqual(self.run_main(*self.open_args(), FAKE_SSH_MODE="banner")[0], 0)
        self.assertEqual(len(self.parent_registry()), 1)

    def test_without_a_herdr_server_the_launch_line_is_printed(self):
        rc, out, err = self.run_main(*self.open_args(), FAKE_REMOTE_HERDR_DOWN="1")
        self.assertEqual(rc, 0, err)
        entry = self.parent_registry()[0]
        self.assertEqual(entry["status"], "pending")
        launch = (Path(entry["remoteHandoff"]) / "launch.txt").read_text("utf-8").strip()
        self.assertIn(launch, out)

    def test_unlisted_machine(self):
        err = self.refused(*self.open_args(machine="delta"), code="machine_not_allowed")
        self.assertEqual(self.ssh_calls(), [])
        self.assertEqual(lines_of(self.logs["herdr"]), [])
        self.write_config({})
        self.refused(*self.open_args(), code="machine_not_allowed")
        self.assertEqual(self.ssh_calls(), [])
        self.assertIn("sessions.machines", err)

    def test_machines_listed_only_in_the_project_layer_are_not_allowed(self):
        self.write_config({})
        proj = self.tmp / "p2"
        (proj / ".pi").mkdir(parents=True)
        (proj / ".pi" / "foreman.json").write_text(json.dumps({"sessions": {"machines": {"alpha": {}}}}), "utf-8")
        self.refused(*self.open_args(cwd=proj), code="machine_not_allowed")

    def test_machine_must_be_saved_and_enabled_in_herdr(self):
        self.refused(*self.open_args(machine="beta"), code="machine_disabled")
        self.write_config({"alpha": {}, "delta": {}})
        self.refused(*self.open_args(machine="delta"), code="machine_unknown")
        self.refused(*self.open_args(), code="machine_unknown", FAKE_HERDR_MACHINES="[]")
        twice = PARENT_MACHINES + [dict(PARENT_MACHINES[0], label="ALPHA")]
        self.refused(*self.open_args(), code="machine_unknown", FAKE_HERDR_MACHINES=json.dumps(twice))
        self.assertEqual(self.ssh_calls(), [])

    def test_the_ssh_target_comes_only_from_a_usable_herdr_row(self):
        for target in ("-oProxyCommand=evil", "a b", "x;y", "", "a" * 201):
            rows = [dict(PARENT_MACHINES[0], target=target)]
            self.refused(*self.open_args(), code="machine_target", FAKE_HERDR_MACHINES=json.dumps(rows))
        self.assertEqual(self.ssh_calls(), [])

    def test_herdr_missing(self):
        self.refused(*self.open_args(), code="herdr_missing", PATH=str(self.pibin), HERDR_BIN="")
        self.assertEqual(self.ssh_calls(), [])

    def test_ssh_missing(self):
        (self.bin / "ssh").unlink()
        real_which = shutil.which
        with mock.patch.object(fsn.shutil, "which", side_effect=lambda n, *a, **k: None if n == "ssh" else real_which(n, *a, **k)):
            self.refused(*self.open_args(), code="ssh_missing")

    def test_no_return_path_without_a_session_uuid_and_a_pane(self):
        self.refused(*self.open_args(parent="fm-stable-id"), code="no_return_path")
        self.refused(*self.open_args(parent=None), code="no_return_path")
        self.refused(*self.open_args(), code="no_return_path", HERDR_PANE_ID="")
        self.assertEqual(self.ssh_calls(), [])

    def test_cwd_is_required_and_trust_needs_a_machine(self):
        self.refused("open", "demo", str(self.brief), "--machine", "alpha", "--parent-id", PARENT, code="cwd_required")
        rc, out, err = self.run_main("open", "demo", str(self.brief), "--trust", "--cwd", str(self.tmp), "--parent-id", PARENT)
        self.assertEqual(rc, 1)
        self.assertIn("--trust needs --machine", err)

    def test_remote_cwd_is_passed_unresolved(self):
        self.assertEqual(self.run_main(*self.open_args(cwd="/home/u/p"))[0], 1)  # the remote refuses: no such directory
        self.assertEqual(json.loads(self.ssh_calls()[1]["stdin"])["cwd"], "/home/u/p")

    def test_rank_refusal_happens_before_any_ssh(self):
        ranks = [{"match": "big-*", "tier": 0}, {"match": "small-*", "tier": 2}]
        self.write_config({"alpha": {"parentName": "beta"}}, {"providers": {"prov": {"ranks": ranks}}})
        err = self.refused(*self.open_args("--model", "big-x", "--own-model", "small-y"), code="session_rank")
        self.assertIn("tier 0", err)
        self.assertEqual(self.ssh_calls(), [])

    def test_probe_refusals(self):
        err = self.refused(*self.open_args(), code="no_return_path", FAKE_REMOTE_HERDR_MACHINES="[]")
        self.assertIn("beta", err)
        self.assertEqual(len(self.ssh_calls()), 1)  # probe only
        self.refused(*self.open_args(), code="remote_protocol", FAKE_SSH_PROTOCOL="2")
        self.refused(*self.open_args(), code="remote_missing", FAKE_REMOTE_PATH=str(self.bin))
        self.refused(*self.open_args(), code="remote_missing", FAKE_NO_INTERCOM="1")
        self.assertEqual(self.remote_registry(), [])

    def test_protocol_mismatch_names_both_values(self):
        err = self.refused(*self.open_args(), code="remote_protocol", FAKE_SSH_PROTOCOL="2")
        self.assertIn("remote alpha speaks protocol 2, this side speaks 1;", err)

    def test_remote_refusals_are_passed_through(self):
        (self.rproj / ".pi").mkdir()
        err = self.refused(*self.open_args(), code="remote_untrusted")
        self.assertIn("remote alpha", err)
        self.assertEqual(len(self.ssh_calls()), 2)
        self.assertEqual(self.run_main(*self.open_args("--trust"))[0], 0)
        self.assertIs(foreman_trust.decision(self.radir, self.rproj), True)

    def test_dry_run_writes_nothing_on_either_side(self):
        rc, out, err = self.run_main(*self.open_args("--dry-run"))
        self.assertEqual(rc, 0, err)
        self.assertEqual(json.loads(self.ssh_calls()[1]["stdin"])["dryRun"], True)
        self.assertEqual(self.parent_registry(), [])
        self.assertFalse((self.padir / "pi-foreman").exists())
        self.assertFalse((self.radir / "pi-foreman").exists())

    def test_unreachable_leaves_no_local_entry(self):
        for mode, text in (("255", "Connection refused"), ("nonjson", "no usable reply"), ("timeout", "no answer within 1 s")):
            with mock.patch.object(fsn, "PROBE_TIMEOUT", 1):
                rc, out, err = self.run_main(*self.open_args(), FAKE_SSH_MODE=mode)
            self.assertEqual(rc, 1, mode)
            self.assertIn("remote alpha unreachable: ", err)
            self.assertIn(text, err)
            self.assertNotIn("refused [", err)
            self.assertNotIn(": refused:", err)
            self.assertEqual(self.parent_registry(), [])
            self.assertFalse((self.padir / "pi-foreman").exists())

    def test_open_unreachable_after_a_good_probe(self):
        real = fsn.ssh_verb

        def flaky(name, target, command, verb, payload, timeout):
            if verb == "open":
                raise fsn.Unreachable("remote %s unreachable: dropped" % name)
            return real(name, target, command, verb, payload, timeout)

        with mock.patch.object(fsn, "ssh_verb", side_effect=flaky):
            rc, out, err = self.run_main(*self.open_args())
        self.assertEqual((rc, self.parent_registry()), (1, []))
        self.assertIn("remote alpha unreachable: dropped", err)

    def test_timeouts_per_verb(self):
        self.assertEqual((fsn.PROBE_TIMEOUT, fsn.OPEN_TIMEOUT, fsn.DELIVER_TIMEOUT), (15, 60, 20))
        seen = []
        real = fsn.subprocess.run

        def spy(argv, **kw):
            if argv and Path(argv[0]).name == "ssh":
                seen.append(kw.get("timeout"))
            return real(argv, **kw)

        with mock.patch.object(fsn.subprocess, "run", side_effect=spy):
            self.assertEqual(self.run_main(*self.open_args())[0], 0)
        self.assertEqual(seen, [15, 60])

    def test_local_open_is_unchanged_by_the_new_flags(self):
        proj = self.tmp / "local"
        proj.mkdir()
        rc, out, err = self.run_main("open", "demo", str(self.brief), "--cwd", str(proj), "--parent-id", "parent-1", "--dry-run")
        self.assertEqual(rc, 0, err)
        self.assertEqual(self.ssh_calls(), [])
        self.assertTrue(out.startswith("handoff: "))


@posix_only
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
        last = json.loads(self.ssh_calls()[-1]["stdin"])
        self.assertEqual((last["kind"], last["name"], last["parentAddress"], last["handoffName"]),
                         ("brief", "brief-2.md", ADDRESS, self.entry["handoffName"]))
        self.assertEqual(self.ssh_calls()[-1]["argv"][-1], "foreman session remote deliver --json")
        call = lines_of(self.logs["node"])[-1]
        self.assertEqual(call["argv"][1:4], ["send", "--to", self.entry["child"]])

    def ssh_calls(self):
        return lines_of(self.logs["ssh"])

    def test_allowlisted_basename_keeps_its_name_and_kind(self):
        for name, kind in (("ruling.md", "ruling"), ("ruling-plan.md", "ruling"), ("ruling-2.md", "ruling"),
                           ("steer-1.md", "steer"), ("brief-7.md", "brief")):
            f = self.tmp / name
            f.write_text("content of " + name, "utf-8")
            self.assertEqual(self.send(str(f))[0], 0, name)
            sent = json.loads(self.ssh_calls()[-1]["stdin"])
            self.assertEqual((sent["kind"], sent["name"], sent["content"]), (kind, name, "content of " + name))
            self.assertEqual((self.rh / name).read_text("utf-8"), "content of " + name)

    def test_other_files_become_numbered_briefs(self):
        f = self.tmp / "notes.md"
        f.write_text("some notes", "utf-8")
        self.assertEqual(self.send(str(f))[0], 0)
        self.assertEqual((self.rh / "brief-1.md").read_text("utf-8"), "some notes")
        self.assertEqual(self.parent_registry()[0]["briefs"], 1)

    def test_cjk_brief_over_ssh(self):
        text = "\u6f22" * 21845
        self.assertEqual(self.send(text)[0], 0)
        self.assertEqual((self.rh / "brief-1.md").read_text("utf-8"), text)

    def test_failure_sets_last_error_and_exit_1(self):
        rc, out, err = self.send("hello", FAKE_SSH_MODE="255")
        self.assertEqual(rc, 1)
        self.assertIn("remote alpha unreachable", err)
        entry = self.parent_registry()[0]
        self.assertEqual(entry["briefs"], 0)
        self.assertIn("unreachable", entry["lastError"])
        self.assertFalse((self.rh / "brief-1.md").exists())
        self.assertEqual(self.send("hello")[0], 0)  # a later success clears it
        entry = self.parent_registry()[0]
        self.assertEqual((entry["briefs"], entry["lastError"]), (1, None))

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
                        HERDR_PANE_ID="")

    def notice(self, *args, **env):
        code, out, err = self.run_main("remote", "notice", *args, **env)
        return code, json.loads(out)

    def sent(self):
        return lines_of(self.logs["node"])


@posix_only
class NoticeTest(NoticeBase):
    def test_result_notice(self):
        data = "# Result\n\nAll done \u2713\n".encode("utf-8")
        (self.dir / "result.md").write_bytes(data)
        code, r = self.notice("result")
        self.assertEqual((code, r), (0, {"sent": True, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
                                         "truncated": False, "ok": True}))
        call = self.sent()[0]
        self.assertEqual(call["argv"][1:5], ["send", "--to", ADDRESS, "--text"])
        self.assertEqual(call["session"], self.child)
        head = "Result from demo: %s sha256:%s bytes:%d" % (self.dir / "result.md", r["sha256"], len(data))
        self.assertEqual(call["argv"][5], head + "\n---\n" + data.decode("utf-8"))

    def test_kinds_use_their_files(self):
        for kind, name, head in (("plan", "plan.md", "Plan"), ("update", "result.md", "Update"), ("ask", "ask.md", "Ask")):
            (self.dir / name).write_text("body of " + name, "utf-8")
            self.assertEqual(self.notice(kind)[0], 0)
            self.assertTrue(self.sent()[-1]["argv"][5].startswith("%s from demo: %s sha256:" % (head, self.dir / name)))
        self.assertEqual(self.notice("plan", "plan.md")[0], 0)  # the default name, relative to the handoff dir
        self.assertEqual(self.notice("plan", str(self.dir / "plan.md"))[0], 0)

    def test_truncation_at_a_character_boundary(self):
        self.write_config({}, {"sessions": {"remoteInlineMaxBytes": 1024}}, adir=self.radir)
        data = ("\u6f22" * 500).encode("utf-8")  # 1500 bytes; 1024 falls inside a character
        (self.dir / "result.md").write_bytes(data)
        code, r = self.notice("result")
        self.assertEqual((code, r["truncated"], r["bytes"], r["sha256"]), (0, True, 1500, hashlib.sha256(data).hexdigest()))
        text = self.sent()[0]["argv"][5]
        head, body = text.split("\n---\n", 1)
        self.assertTrue(head.endswith("bytes:1500 truncated"), head)
        self.assertEqual(body, "\u6f22" * 341)  # 1023 bytes: the partial character is dropped
        self.assertLessEqual(len(body.encode("utf-8")), 1024)

    def test_default_cap(self):
        (self.dir / "result.md").write_text("x" * 40000, "utf-8")
        code, r = self.notice("result")
        self.assertTrue(r["truncated"])
        self.assertEqual(len(self.sent()[0]["argv"][5].split("\n---\n", 1)[1]), 32768)

    def test_closed_notice(self):
        code, r = self.notice("closed", "--close", "ready")
        self.assertEqual((code, r["ok"]), (0, True))
        self.assertEqual(self.sent()[-1]["argv"][5], "foreman:closed CLOSE: ready")  # no result.md yet
        (self.dir / "result.md").write_text("r", "utf-8")
        self.assertEqual(self.notice("closed", "--close", "open")[0], 0)
        self.assertEqual(self.sent()[-1]["argv"][5], "foreman:closed %s CLOSE: open" % (self.dir / "result.md"))
        self.assertEqual(self.notice("closed")[0], 0)
        self.assertEqual(self.sent()[-1]["argv"][5], "foreman:closed %s" % (self.dir / "result.md"))

    def test_no_entry(self):
        (self.dir / "child").write_text("fm-other-000000\n", "utf-8")
        code, r = self.notice("closed")
        self.assertEqual((code, r["code"]), (1, "no_entry"))
        (self.dir / "child").unlink()
        self.assertEqual(self.notice("closed")[1]["code"], "no_entry")
        self.assertEqual(self.sent(), [])

    def test_bad_name(self):
        (self.dir / "result.md").write_text("r", "utf-8")
        (self.dir / "other.md").write_text("o", "utf-8")
        for args in (("result", "other.md"), ("result", str(self.dir / "other.md")), ("result", "../result.md"),
                     ("plan", "result.md"), ("ask", str(self.tmp / "ask.md")), ("plan",)):
            code, r = self.notice(*args)
            self.assertEqual((code, r["code"]), (1, "bad_name"), args)  # ("plan",): plan.md does not exist
        self.assertEqual(self.sent(), [])

    @unittest.skipIf(sys.platform == "win32", "symlinks need privileges on win32")
    def test_symlinked_file_is_refused(self):
        (self.tmp / "secret.txt").write_text("secret", "utf-8")
        (self.dir / "result.md").symlink_to(self.tmp / "secret.txt")
        code, r = self.notice("result")
        self.assertEqual((code, r["code"]), (1, "bad_name"))
        self.assertEqual(self.sent(), [])

    def test_bad_parent_file(self):
        (self.dir / "result.md").write_text("r", "utf-8")
        for text in ("xyz", "not-a-uuid@beta", PARENT, PARENT + "@-x", PARENT + "@a b"):
            (self.dir / "parent").write_text(text + "\n", "utf-8")
            code, r = self.notice("result")
            self.assertEqual((code, r["code"]), (1, "bad_parent"), text)
        self.assertEqual(self.sent(), [])

    def test_failed_send_exits_1(self):
        (self.dir / "result.md").write_text("r", "utf-8")
        code, r = self.notice("result", FAKE_NODE_EXIT="1")
        self.assertEqual((code, r["ok"], r["code"]), (1, False, "send_failed"))
        self.assertIn("broker down", r["error"])

    def test_needs_the_remote_parent_environment(self):
        (self.dir / "result.md").write_text("r", "utf-8")
        self.assertEqual(self.notice("result", PI_FOREMAN_REMOTE_PARENT="")[1]["code"], "not_remote")
        self.assertEqual(self.notice("result", PI_FOREMAN_HANDOFF_DIR="")[1]["code"], "no_handoff")
        self.assertEqual(self.sent(), [])

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
        rc, out, err = self.run_main(*argv[4:])
        self.assertEqual(rc, 0, err)
        self.assertIn("from the footer", self.sent()[-1]["argv"][5])
        closed = by_kind["closed"]
        self.assertEqual(closed[-2:], ["--close", "ready"])
        self.assertEqual(self.run_main(*closed[4:])[0], 0)
        self.assertTrue(self.sent()[-1]["argv"][5].endswith("CLOSE: ready"))


class NoticeWin32Test(NoticeBase):
    """Patched-platform and pure-function cases: no fake POSIX executable runs, so they run on every platform."""

    def setUp(self):
        patch = mock.patch.object(fsn, "herdr_bin", return_value=None)  # the remote open is then pending, no herdr call
        patch.start()
        self.addCleanup(patch.stop)
        super().setUp()

    def test_win32_cut_keeps_the_command_line_under_the_limit(self):
        self.write_config({}, {"sessions": {"remoteInlineMaxBytes": 49152}}, adir=self.radir)
        data = b"x" * 49152
        (self.dir / "result.md").write_bytes(data)
        captured = []

        def fake_run(argv, **kw):
            captured.append(argv)
            return subprocess.CompletedProcess(argv, 0, b"", b"")

        with mock.patch.object(fsn, "host_platform", return_value="win32"), \
                mock.patch.object(fsn.shutil, "which", return_value="C:/tools/node.exe"), \
                mock.patch.object(fsn.subprocess, "run", side_effect=fake_run):
            code, r = self.notice("result")
        argv = captured[0]
        self.assertEqual(code, 0)
        self.assertLessEqual(len(subprocess.list2cmdline(argv)), 32000)
        head = "Result from demo: %s sha256:%s bytes:%d truncated" % (self.dir / "result.md", r["sha256"], len(data))

        def fits(n):  # the rule: the longest cut whose command line is within 32000 characters
            text = "%s\n---\n%s" % (head, "x" * n)
            return len(subprocess.list2cmdline(argv[:6] + [text])) <= 32000

        body = len(argv[6].split("\n---\n", 1)[1])
        self.assertTrue(fits(body) and not fits(body + 1), body)
        self.assertTrue(r["truncated"])

    def test_win32_node_must_be_an_exe(self):
        (self.dir / "result.md").write_text("x", "utf-8")
        with mock.patch.object(fsn, "host_platform", return_value="win32"), \
                mock.patch.object(fsn.shutil, "which", return_value="C:/tools/node.cmd"):
            code, r = self.notice("result")
        self.assertEqual((code, r["code"]), (1, "node_shim"))
        self.assertEqual(self.sent(), [])

    def test_footer_forms(self):
        for plan_first in (False, True):
            with mock.patch.object(fsn, "host_platform", return_value="win32"):
                text = fsn.remote_footer("demo", plan_first, 32768)
            cmds = [l.strip() for l in text.splitlines() if " remote notice " in l]
            self.assertTrue(cmds)
            for c in cmds:
                self.assertNotIn("\\", c)
                self.assertNotIn("&", c)
                self.assertNotIn("session remote", c)
            self.assertEqual(any(c.endswith(" plan") for c in cmds), plan_first)
            self.assertIn("32768 bytes", text)
            self.assertIn("the owner closes this pane on this machine", text)
            self.assertIn("ruling-<n>.md", text)
            self.assertEqual("`ruling.md`" in text, plan_first)


class RemoteOptionTest(RemoteBase):
    def test_unsupported_flags_are_refused_with_machine(self):
        for flag in ("--plan-mode", "--first-command", "--focus", "--print-all"):
            extra = (flag, "/x") if flag == "--first-command" else (flag,)
            rc, out, err = self.run_main(*self.open_args(*extra))
            self.assertEqual(rc, 1, flag)
            self.assertIn("[remote_option]", err)
            self.assertIn("%s is not supported with --machine" % flag, err)
            self.assertEqual(lines_of(self.logs["ssh"]), [], flag)
            self.assertEqual(lines_of(self.logs["herdr"]), [], flag)
            self.assertEqual(self.parent_registry(), [], flag)
            self.assertFalse((self.padir / "pi-foreman").exists(), flag)
            self.assertFalse((self.radir / "pi-foreman").exists(), flag)

    def test_local_open_with_plan_mode_still_works(self):
        rc, out, err = self.run_main("open", "demo", str(self.brief), "--cwd", str(self.rproj), "--parent-id", PARENT,
                                     "--plan-mode", "--dry-run")
        self.assertEqual(rc, 0, err)
        self.assertIn("pi /plan ", out)
        self.assertEqual(lines_of(self.logs["ssh"]), [])


class TrailingNewlineTest(unittest.TestCase):
    def test_validation_patterns_refuse_a_trailing_newline(self):
        ok = {"MACHINE_RE": "alpha", "UUID_RE": PARENT, "ADDRESS_RE": ADDRESS, "FOREMAN_CMD_RE": "foreman",
              "TARGET_RE": "alpha-host", "HANDOFF_NAME_RE": "20261024-120000-demo", "LABEL_RE": "demo", "VALUE_RE": "model-1"}
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
