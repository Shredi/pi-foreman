"""End to end: the bundled pi-intercom fork's CLI sends `<uuid>@<parent>` over crossMachine.transport "hc".

The CLI under test is node_modules/pi-intercom/cli.mjs (the pinned fork, no build). hc is the shared fake of
tests/fakes/hc.py: `machine ls` answers from FAKE_HC_MACHINES, and `exec --on <m> -- pi-intercom relay ...` runs the
`pi-intercom` found on PATH as a subprocess and returns its reply base64 in hc's `stdout` field. That program here is a
tiny stand-in for the parent's relay that answers {"ok": true}; FAKE_HC_EXEC_LOG records the argv and the envelope the CLI
pipes in. The CLI registers with a local intercom broker first and does not start one, so the test runs the fork's own
broker (broker/broker.ts through tsx) in the temp agent dir. Skipped on Windows: the fork spawns hc without a shell and
so cannot start the fake's hc.cmd.
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

sys.path.insert(0, str(Path(__file__).resolve().parent / "fakes"))
from hc_install import install_fake_hc  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "node_modules" / "pi-intercom" / "cli.mjs"
NODE = shutil.which("node")
PARENT = "11111111-2222-3333-4444-555555555555"

RELAY = """import json, sys
sys.stdin.read()
print(json.dumps({"ok": True, "version": 1, "delivered": True, "id": "fake-1"}))
"""


@unittest.skipIf(sys.platform == "win32", "the fork spawns hc without a shell and cannot start the fake hc.cmd")
@unittest.skipIf(NODE is None or not CLI.is_file(), "needs node and node_modules/pi-intercom/cli.mjs (npm install)")
class IntercomHcTransportTest(unittest.TestCase):
    def setUp(self):
        # short path: the broker's unix socket path must stay under the OS limit
        self.dir = Path(tempfile.mkdtemp(prefix="ic-", dir="/tmp" if os.path.isdir("/tmp") else None))
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.agent = self.dir / "agent"
        (self.agent / "intercom").mkdir(parents=True)
        bin_dir = install_fake_hc(self.dir / "bin")
        (bin_dir / "relay.py").write_text(RELAY, encoding="utf-8")
        relay = bin_dir / "pi-intercom"
        relay.write_text('#!/bin/sh\nexec "%s" "%s" "$@"\n' % (sys.executable, bin_dir / "relay.py"), encoding="utf-8")
        relay.chmod(0o755)
        self.log = self.dir / "exec.log"
        machines = [{"name": "parentbox", "state": "up"}, {"name": "offbox", "state": "disabled"}]
        self.env = {**os.environ, "PI_CODING_AGENT_DIR": str(self.agent), "HC_BIN": str(bin_dir / "hc"),
                    "PATH": str(bin_dir) + os.pathsep + os.environ.get("PATH", ""),
                    "FAKE_HC_MACHINES": json.dumps(machines), "FAKE_HC_EXEC_LOG": str(self.log)}
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

    def execs(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]

    def test_send_reaches_the_relay_over_hc(self):
        self.config({"transport": "hc", "machineName": "childbox"})
        r = self.send(PARENT + "@parentbox")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual((out["ok"], out["delivered"], out["crossMachine"], out["machine"]), (True, True, True, "parentbox"))
        execs = self.execs()
        self.assertEqual(len(execs), 1, execs)
        self.assertEqual(execs[0]["argv"], ["pi-intercom", "relay", "--envelope-stdin", "--json"])
        envelope = json.loads(execs[0]["stdin"])
        self.assertEqual((envelope["version"], envelope["target"], envelope["text"]), (1, PARENT, "build done"))
        self.assertEqual(envelope["origin"]["machine"], "childbox")

    def test_unknown_machine_is_refused_before_any_exec(self):
        self.config({"transport": "hc", "machineName": "childbox"})
        r = self.send(PARENT + "@offbox")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("unknown or disabled", r.stdout + r.stderr)
        self.assertEqual(self.execs(), [])


if __name__ == "__main__":
    unittest.main()
