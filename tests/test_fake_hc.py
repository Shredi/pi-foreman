"""tests/fakes/hc.py: the fake `hc` of the test rig, on POSIX and Windows."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS / "fakes"))
from hc_install import install_fake_hc  # noqa: E402


class FakeHc(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="fake-hc-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = install_fake_hc(self.tmp / "bin")
        self.state = self.tmp / "state"
        self.log = self.tmp / "hc.log"
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("FAKE_HC_")}
        self.env.update(PATH=str(self.bin) + os.pathsep + os.environ.get("PATH", ""), FAKE_HC_LOG=str(self.log),
                        FAKE_HC_STATE=str(self.state))

    def hc(self, *args, stdin=None, env=None, text=True):
        exe = shutil.which("hc", path=self.env["PATH"])
        return subprocess.run([exe, *args], input=stdin, capture_output=True, text=text, env=env or self.env)

    def test_install_helper(self):
        self.assertEqual(self.bin, self.tmp / "bin")
        names = {p.name for p in self.bin.iterdir()}
        self.assertEqual(names, {"hc.cmd", "hc.py"} if sys.platform == "win32" else {"hc"})
        self.assertEqual(Path(shutil.which("hc", path=self.env["PATH"])).parent, self.bin)

    def test_logs_argv(self):
        self.hc("machine", "ls", "--json")
        self.hc("get", "m/t9")
        lines = [json.loads(x) for x in self.log.read_text("utf-8").splitlines()]
        self.assertEqual(lines, [["machine", "ls", "--json"], ["get", "m/t9"]])

    def test_machine_ls(self):
        env = dict(self.env, FAKE_HC_MACHINES=json.dumps(["alpha", {"name": "beta", "state": "down"}]))
        rows = json.loads(self.hc("machine", "ls", "--json", env=env).stdout)["machines"]
        self.assertEqual([r["name"] for r in rows], ["alpha", "beta"])
        self.assertEqual(sorted(rows[0]), ["host", "id", "name", "session", "state", "target", "temporary", "version", "via"])
        self.assertEqual(rows[1], {"name": "beta", "state": "down"})
        self.assertEqual(json.loads(self.hc("machine", "ls", "--json").stdout), {"machines": []})

    def test_server_status(self):
        r = self.hc("server", "status", "--json")
        self.assertEqual((r.returncode, json.loads(r.stdout)["state"]), (0, "up"))
        r = self.hc("server", "status", "--json", env=dict(self.env, FAKE_HC_CORE_DOWN="1"))
        self.assertEqual(r.returncode, 1)

    def exec_env(self):
        agent = self.tmp / "agent"
        agent.mkdir(exist_ok=True)
        return dict(self.env, FAKE_REMOTE_AGENT=str(agent), FAKE_SCRIPTS=str(TESTS.parent / "scripts"))

    def test_exec_dispatches_verb_in_process_with_windows_argv(self):
        argv = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:/x/bin/foreman.ps1",
                "session", "remote", "probe", "--json"]
        r = self.hc("exec", "--on", "alpha", "-i", "--timeout", "30", "--json", "--", *argv,
                    stdin="{}", env=self.exec_env())
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual(sorted(out), ["code", "ms", "signal", "stderr", "stdout", "timed_out", "truncated"])
        self.assertEqual((out["code"], out["timed_out"], out["truncated"], out["signal"]), (1, False, False, None))
        self.assertEqual(json.loads(base64.b64decode(out["stdout"])),
                         {"ok": False, "code": "bad_request", "error": "missing field: parentName"})
        self.assertEqual(base64.b64decode(out["stderr"]), b"")

    def test_exec_runs_pi_intercom_as_a_subprocess_with_stdin(self):
        prog = self.tmp / "prog"
        prog.mkdir()
        (prog / "pi_intercom.py").write_text("import sys; sys.stdout.write(sys.stdin.read().upper()); sys.stderr.write('e'); sys.exit(4)")
        if sys.platform == "win32":
            (prog / "pi-intercom.cmd").write_text(f'@"{sys.executable}" "%~dp0pi_intercom.py" %*\r\n')
        else:
            (prog / "pi-intercom").write_text(f'#!/bin/sh\nexec "{sys.executable}" "{prog}/pi_intercom.py" "$@"\n')
            (prog / "pi-intercom").chmod(0o755)
        env = dict(self.exec_env(), PATH=str(prog) + os.pathsep + self.env["PATH"])
        r = self.hc("exec", "--on", "alpha", "-i", "--json", "--", "pi-intercom", "relay", stdin="abc", env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual((out["code"], out["timed_out"]), (4, False))
        self.assertEqual(base64.b64decode(out["stdout"]), b"ABC")
        self.assertEqual(base64.b64decode(out["stderr"]), b"e")

    def test_exec_exit_code_and_stdout_without_json(self):
        r = self.hc("exec", "--on", "alpha", "--", "/x/bin/foreman", "session", "remote", "probe", "--json",
                    stdin="{}", env=self.exec_env())
        self.assertEqual(r.returncode, 1)
        self.assertEqual(json.loads(r.stdout)["code"], "bad_request")

    def test_exec_failure_modes(self):
        argv = ["foreman", "session", "remote", "probe", "--json"]
        r = self.hc("exec", "--on", "alpha", "--json", "--", *argv, stdin="{}",
                    env=dict(self.exec_env(), FAKE_HC_EXEC_MODE="timed_out"))
        self.assertEqual((r.returncode, json.loads(r.stdout)["timed_out"]), (0, True))
        r = self.hc("exec", "--on", "alpha", "--json", "--", *argv, stdin="{}",
                    env=dict(self.exec_env(), FAKE_HC_EXEC_MODE="spawn_failed"))
        self.assertEqual((r.returncode, r.stdout), (1, ""))
        self.assertEqual(json.loads(r.stderr)["error"]["kind"], "spawn_failed")
        r = self.hc("exec", "--on", "alpha", "--json", "--", *argv, stdin="{}",
                    env=dict(self.exec_env(), FAKE_HC_EXEC_MODE="cp850"))
        self.assertEqual(base64.b64decode(json.loads(r.stdout)["stderr"]).decode("cp850"), "caf\u00e9 failed")

    def test_exec_log_and_remote_protocol_stub(self):
        log = self.tmp / "exec.log"
        argv = ["foreman", "session", "remote", "probe", "--json"]
        env = dict(self.exec_env(), FAKE_HC_EXEC_LOG=str(log), FAKE_SSH_PROTOCOL="7")
        payload = json.dumps({"parentName": "beta", "parentAddress": "11111111-2222-3333-4444-555555555555@beta"})
        r = self.hc("exec", "--on", "alpha", "--json", "--", *argv, stdin=payload, env=env)
        out = json.loads(base64.b64decode(json.loads(r.stdout)["stdout"]).decode("utf-8").splitlines()[-1])
        self.assertEqual(out["protocol"], 7)
        (line,) = [json.loads(x) for x in log.read_text("utf-8").splitlines()]
        self.assertEqual((line["argv"], line["stdin"]), (argv, payload))

    def test_exec_refuses_argv_without_remote_verb(self):
        r = self.hc("exec", "--on", "alpha", "--", sys.executable, "-c", "print(1)", stdin="", env=self.exec_env())
        self.assertEqual(r.returncode, 2)
        self.assertEqual(r.stdout, "")

    def test_run_label_events_get_wait(self):
        r = self.hc("run", "--on", "alpha", "--json", "--name", "fm-x", "--label", "fm.child=c1", "--cwd", "/w", "--", "sleep", "9")
        self.assertEqual(json.loads(r.stdout), {"address": "alpha/t1", "agent": None, "cwd": "/w", "name": "fm-x",
                                                "parent": None, "state": "working", "turn": 0})
        digest = "a" * 64
        self.hc("label", "alpha/t1", f"fm.notice=1:plan:{digest}:12345")
        lines = [json.loads(x) for x in self.hc("events", "--json").stdout.splitlines()]
        self.assertEqual(sorted(lines[0]), ["channel", "seq", "terminals"])  # the snapshot comes first
        self.assertEqual([t["address"] for t in lines[0]["terminals"]], ["alpha/t1"])
        self.assertEqual(lines[0]["terminals"][0]["status"], {"app": "pi", "state": "working"})
        self.assertEqual(len(lines), 2)
        ev = lines[1]
        self.assertEqual((ev["jsonrpc"], ev["method"]), ("2.0", "event"))
        self.assertEqual((ev["params"]["type"], ev["params"]["terminal"]), ("labels", "alpha/t1"))
        self.assertEqual(ev["params"]["data"]["labels"], {"fm.child": "c1", "fm.notice": f"1:plan:{digest}:12345"})
        self.assertEqual(self.hc("events", "--json", "--label", "fm.child=c1").stdout.count("\n"), 2)
        self.assertEqual(self.hc("events", "--json", "--label", "fm.child=zz").stdout.count("\n"), 1)  # the snapshot only
        for sub in ("get", "wait"):
            args = [sub, "alpha/t1", "--json"]
            rec = json.loads(self.hc(*args).stdout)
            self.assertEqual(rec["labels"]["fm.child"], "c1")
            self.assertEqual(rec["labels"]["fm.notice"], f"1:plan:{digest}:12345")

    def test_run_without_on_is_local(self):
        r = self.hc("run", "--json", "--bg", "--no-parent", "--name", "fm-y", "--", "sleep", "9")
        out = json.loads(r.stdout)
        self.assertEqual((out["address"], out["name"]), ("t1", "fm-y"))
        self.assertEqual(sorted(out), ["address", "agent", "cwd", "name", "parent", "state", "turn"])

    def test_kill_and_rm(self):
        self.hc("run", "--on", "alpha", "--", "sleep", "9")
        self.hc("kill", "alpha/t1")
        rec = json.loads(self.hc("get", "alpha/t1").stdout)
        self.assertEqual((rec["state"], rec["status"]["state"]), ("finished", "done"))
        self.hc("rm", "alpha/t1")
        r = self.hc("get", "alpha/t1")
        self.assertEqual(r.returncode, 3)  # the real hc: exit 3, {"error": {"kind": "not_found"}} on stderr
        self.assertEqual(json.loads(r.stderr)["error"]["kind"], "not_found")

    def test_events_follow_prints_new_labels_and_heartbeats(self):
        self.hc("run", "--on", "alpha", "--", "sleep", "9")
        exe = shutil.which("hc", path=self.env["PATH"])
        env = dict(self.env, FAKE_HC_EVENTS_FOLLOW="3")
        p = subprocess.Popen([exe, "events", "--json"], stdout=subprocess.PIPE, text=True, env=env)
        self.addCleanup(p.stdout.close)
        self.addCleanup(p.kill)
        self.assertIn("terminals", json.loads(p.stdout.readline()))
        self.hc("label", "alpha/t1", "fm.notice=1:ask:-:0")
        got = [json.loads(p.stdout.readline()) for _ in range(2)]
        self.assertEqual(sorted(x["method"] for x in got), ["event", "heartbeat"])
        p.wait(timeout=10)

    def test_file_read_bytes_exact(self):
        self.state.mkdir(parents=True)
        data = "caf\u00e9 \u2713\r\nsecond\r\n".encode("utf-8")
        (self.state / "plan.md").write_bytes(data)
        r = self.hc("file", "read", "--on", "alpha", "plan.md", text=False)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(hashlib.sha256(r.stdout).hexdigest(), hashlib.sha256(data).hexdigest())
        self.assertEqual(r.stdout, data)

    def test_file_read_json(self):
        self.state.mkdir(parents=True)
        (self.state / "plan.md").write_bytes("one\ntwo \u2713\n".encode("utf-8"))
        r = self.hc("file", "read", "--on", "alpha", "plan.md", "--json")
        self.assertEqual(json.loads(r.stdout), {"first": 1, "last": 2, "lines": 2, "text": "one\ntwo \u2713\n"})

    def test_file_read_refuses_outside_state(self):
        self.state.mkdir(parents=True)
        (self.tmp / "secret.txt").write_text("x", "utf-8")
        r = self.hc("file", "read", "--on", "alpha", "../secret.txt", text=False)
        self.assertEqual(r.returncode, 2)

    def test_fail_mode(self):
        env = dict(self.env, FAKE_HC_FAIL="1")
        r = self.hc("machine", "ls", "--json", env=env)
        self.assertEqual(r.returncode, 3)
        self.assertEqual(r.stderr.strip(), "boom")
        self.assertIn("machine", self.log.read_text("utf-8"))


if __name__ == "__main__":
    unittest.main()
