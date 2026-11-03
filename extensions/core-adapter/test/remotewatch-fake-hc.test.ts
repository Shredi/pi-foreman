// End to end on the fake hc (tests/fakes/hc.py): a child's `remote notice plan` sets the label, the watcher reads the fake's
// event stream, fetches plan.md with `hc file read` and mirrors it. POSIX only (the fake is installed as a shell script).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteWatcher } from "../remotewatch.ts";
import { readRegistry, writeRegistry } from "../session.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHILD = "0a1b2c3d-0000-4000-8000-0123456789ab";

test("child `remote notice plan` on the fake hc → the watcher mirrors plan.md and wakes with the contract path", { skip: process.platform === "win32" }, async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-rwatch-e2e-")));
  const state = path.join(root, "hcstate");
  const handoff = path.join(state, "handoff", "20261103-120000-demo");
  fs.mkdirSync(handoff, { recursive: true });
  fs.writeFileSync(path.join(handoff, "plan.md"), "# Plan\n1. do it \u6f22\n");
  fs.writeFileSync(path.join(handoff, "child"), `${CHILD}\n`);
  fs.writeFileSync(path.join(handoff, "parent"), "opener-1@gamma\n");
  fs.writeFileSync(path.join(state, "terminals.json"), JSON.stringify({ "alpha/t1": { address: "alpha/t1", labels: {}, status: "working" } }));
  const bin = path.join(root, "bin");
  execFileSync("python3", ["-c", "import sys; sys.path.insert(0, sys.argv[1]); import hc_install; hc_install.install_fake_hc(sys.argv[2])", path.join(repo, "tests", "fakes"), bin]);
  const childAgent = path.join(root, "child-agent");
  writeRegistry(childAgent, { version: 1, sessions: [{ label: "demo", child: CHILD, status: "open", handoff }] });
  const env = { ...process.env, HC_BIN: path.join(bin, "hc"), FAKE_HC_STATE: state, HC_TERMINAL_ID: "alpha/t1", PI_FOREMAN_REMOTE_PARENT: "1", PI_FOREMAN_HANDOFF_DIR: handoff };
  const out = execFileSync("python3", ["-E", "-s", path.join(repo, "scripts", "foreman_session.py"), "--agent-dir", childAgent, "remote", "notice", "plan"], { env, encoding: "utf8" });
  assert.equal((JSON.parse(out) as { seq: number }).seq, 1);

  const agent = path.join(root, "agent");
  const mirror = path.join(agent, "pi-foreman", "remote", "alpha", "20261103-120000-demo");
  writeRegistry(agent, {
    version: 1,
    sessions: [{ label: "demo", child: CHILD, status: "open", machine: "alpha", originMachine: "alpha", remoteHandoff: handoff, mirror, handoff: mirror, backend: "hc", hc: { address: "alpha/t1" }, remote: { platform: "linux" }, briefs: 0 }],
  });
  const old = process.env.HC_BIN;
  process.env.HC_BIN = env.HC_BIN;
  process.env.FAKE_HC_STATE = state;
  const wakes: string[] = [];
  const w = new RemoteWatcher({ agentDir: agent, wake: (l, k, t) => wakes.push(`child ${l}: ${k} ${t}`) });
  try {
    w.start();
    for (let i = 0; i < 100 && !wakes.length; i++) await new Promise((r) => setTimeout(r, 50));
    await w.idle();
  } finally {
    w.stop();
    if (old === undefined) delete process.env.HC_BIN;
    else process.env.HC_BIN = old;
    delete process.env.FAKE_HC_STATE;
  }
  assert.deepEqual(wakes, [`child demo: plan ${path.join(mirror, "plan.md")}`]);
  assert.equal(fs.readFileSync(path.join(mirror, "plan.md"), "utf8"), "# Plan\n1. do it \u6f22\n");
  const e = readRegistry(agent).sessions[0];
  assert.equal(e.noticeSeq, 1);
  assert.equal(e.lastError, null);
  assert.equal((e.remoteLive as { state: string }).state, "working");
});
