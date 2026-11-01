"""tests/fakes/hc.py: the fake `hc` of the test rig, on POSIX and Windows."""
from __future__ import annotations

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
        env = dict(self.env, FAKE_HC_MACHINES=json.dumps([{"name": "alpha"}]))
        self.assertEqual(json.loads(self.hc("machine", "ls", "--json", env=env).stdout), [{"name": "alpha"}])
        self.assertEqual(json.loads(self.hc("machine", "ls", "--json").stdout), [])

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
        self.assertEqual(out["machine"], "alpha")
        self.assertEqual(out["exit"], 1)
        self.assertEqual(json.loads(out["stdout"]),
                         {"ok": False, "code": "bad_request", "error": "missing field: parentName"})

    def test_exec_exit_code_and_stdout_without_json(self):
        r = self.hc("exec", "--on", "alpha", "--", "/x/bin/foreman", "session", "remote", "probe", "--json",
                    stdin="{}", env=self.exec_env())
        self.assertEqual(r.returncode, 1)
        self.assertEqual(json.loads(r.stdout)["code"], "bad_request")

    def test_exec_refuses_argv_without_remote_verb(self):
        r = self.hc("exec", "--on", "alpha", "--", sys.executable, "-c", "print(1)", stdin="", env=self.exec_env())
        self.assertEqual(r.returncode, 2)
        self.assertEqual(r.stdout, "")

    def test_run_label_events_get_wait(self):
        r = self.hc("run", "--on", "alpha", "--json", "--name", "fm-x", "--label", "fm.child=c1", "--", "sleep", "9")
        self.assertEqual(json.loads(r.stdout), {"address": "alpha/t1", "name": "fm-x"})
        digest = "a" * 64
        self.hc("label", "alpha/t1", f"fm.notice=1:plan:{digest}:12345")
        events = [json.loads(x) for x in self.hc("events", "--json").stdout.splitlines()]
        self.assertEqual(events, [{"terminal": "alpha/t1", "label": "fm.notice", "value": f"1:plan:{digest}:12345"}])
        self.assertEqual(self.hc("events", "--json", "--label", "fm.child=c1").stdout.count("\n"), 1)
        self.assertEqual(self.hc("events", "--json", "--label", "fm.child=zz").stdout, "")
        for sub in ("get", "wait"):
            args = [sub, "alpha/t1", "--json"]
            rec = json.loads(self.hc(*args).stdout)
            self.assertEqual(rec["labels"]["fm.child"], "c1")
            self.assertEqual(rec["labels"]["fm.notice"], f"1:plan:{digest}:12345")

    def test_kill_and_rm(self):
        self.hc("run", "--on", "alpha", "--", "sleep", "9")
        self.hc("kill", "alpha/t1")
        self.assertEqual(json.loads(self.hc("get", "alpha/t1").stdout)["status"], "finished")
        self.hc("rm", "alpha/t1")
        self.assertEqual(self.hc("get", "alpha/t1").returncode, 4)

    def test_file_read_bytes_exact(self):
        self.state.mkdir(parents=True)
        data = "caf\u00e9 \u2713\r\nsecond\r\n".encode("utf-8")
        (self.state / "plan.md").write_bytes(data)
        r = self.hc("file", "read", "--on", "alpha", "plan.md", text=False)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(hashlib.sha256(r.stdout).hexdigest(), hashlib.sha256(data).hexdigest())
        self.assertEqual(r.stdout, data)

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
