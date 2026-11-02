"""End to end: the bundled pi-intercom fork's CLI sends `<uuid>@<parent>` over crossMachine.transport "hc".

The CLI under test is node_modules/pi-intercom/cli.mjs (the pinned fork, no build). The fake hc here is a small script that
answers `machine ls --json` and plays the remote broker for `exec`: it records the argv and the relay envelope the CLI
pipes to `pi-intercom relay --envelope-stdin --json` and answers with the relay's {"ok": true} reply, base64 in hc's
`stdout` field as the real hc does. The tests/fakes/hc.py fake only runs `session remote <verb>` and so cannot stand in
for a relay. The CLI registers with a local intercom broker first and does not start one, so the test runs the
fork's own broker (broker/broker.ts through tsx) in the temp agent dir. Skipped on Windows (the fake is a POSIX script; hc is spawned without a shell).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "node_modules" / "pi-intercom" / "cli.mjs"
NODE = shutil.which("node")
PARENT = "11111111-2222-3333-4444-555555555555"

FAKE_HC = r'''#!%(py)s
import base64, json, os, sys
args = sys.argv[1:]
log = os.environ["FAKE_HC_LOG"]
if args[:2] == ["machine", "ls"]:
    with open(log, "a", encoding="utf-8") as f:
        f.write(json.dumps({"call": "machine ls"}) + "\n")
    print(json.dumps({"machines": [{"name": "parentbox", "state": "up"}, {"name": "offbox", "state": "disabled"}]}))
elif args[:1] == ["exec"]:
    stdin = sys.stdin.read()
    with open(log, "a", encoding="utf-8") as f:
        f.write(json.dumps({"call": "exec", "argv": args, "stdin": stdin}) + "\n")
    relay = json.dumps({"ok": True, "version": 1, "delivered": True, "id": "fake-1"})
    print(json.dumps({"code": 0, "ms": 1, "signal": None, "stderr": "", "timed_out": False, "truncated": False,
                      "stdout": base64.b64encode(relay.encode()).decode()}))
else:
    sys.stderr.write("unexpected hc call: %%s\n" %% args)
    sys.exit(3)
'''


@unittest.skipIf(sys.platform == "win32", "the fake hc is a POSIX script and the fork spawns hc without a shell")
@unittest.skipIf(NODE is None or not CLI.is_file(), "needs node and node_modules/pi-intercom/cli.mjs (npm install)")
class IntercomHcTransportTest(unittest.TestCase):
    def setUp(self):
        # short path: the broker's unix socket path must stay under the OS limit
        self.dir = Path(tempfile.mkdtemp(prefix="ic-", dir="/tmp" if os.path.isdir("/tmp") else None))
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.agent = self.dir / "agent"
        (self.agent / "intercom").mkdir(parents=True)
        self.hc = self.dir / "hc"
        self.hc.write_text(FAKE_HC % {"py": sys.executable}, encoding="utf-8")
        self.hc.chmod(0o755)
        self.log = self.dir / "hc.log"
        self.env = {**os.environ, "PI_CODING_AGENT_DIR": str(self.agent), "HC_BIN": str(self.hc), "FAKE_HC_LOG": str(self.log)}
        self.start_broker()

    def start_broker(self):
        pkg = CLI.parent
        tsx = subprocess.run([NODE, "-p", "require.resolve('tsx')"], cwd=pkg, capture_output=True, text=True, timeout=30).stdout.strip()
        broker = subprocess.Popen([NODE, "--import", Path(tsx).as_uri(), str(pkg / "broker" / "broker.ts")],
                                  cwd=self.agent / "intercom", env=self.env, stdin=subprocess.DEVNULL,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(broker.wait, 10)
        self.addCleanup(broker.terminate)
        sock = self.agent / "intercom" / "broker.sock"
        deadline = time.time() + 30
        while not sock.exists():
            if broker.poll() is not None or time.time() > deadline:
                self.fail("the fork's broker did not start")
            time.sleep(0.1)

    def config(self, cross):
        (self.agent / "intercom" / "config.json").write_text(json.dumps({"crossMachine": cross}), encoding="utf-8")

    def send(self, to):
        return subprocess.run([NODE, str(CLI), "send", "--to", to, "--text", "build done", "--name", "child", "--json"],
                              env=self.env, capture_output=True, text=True, timeout=90)

    def calls(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]

    def test_send_reaches_the_fake_broker_over_hc(self):
        self.config({"transport": "hc", "machineName": "childbox"})
        r = self.send(PARENT + "@parentbox")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual((out["ok"], out["delivered"], out["crossMachine"], out["machine"]), (True, True, True, "parentbox"))
        execs = [c for c in self.calls() if c["call"] == "exec"]
        self.assertEqual(len(execs), 1, self.calls())
        argv = execs[0]["argv"]
        self.assertEqual(argv[:3], ["exec", "--on", "parentbox"])
        self.assertEqual(argv[argv.index("--") + 1:], ["pi-intercom", "relay", "--envelope-stdin", "--json"])
        envelope = json.loads(execs[0]["stdin"])
        self.assertEqual((envelope["version"], envelope["target"], envelope["text"]), (1, PARENT, "build done"))
        self.assertEqual(envelope["origin"]["machine"], "childbox")

    def test_unknown_machine_is_refused_before_any_exec(self):
        self.config({"transport": "hc", "machineName": "childbox"})
        r = self.send(PARENT + "@offbox")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("unknown or disabled", r.stdout + r.stderr)
        self.assertEqual([c for c in self.calls() if c["call"] == "exec"], [])


if __name__ == "__main__":
    unittest.main()
