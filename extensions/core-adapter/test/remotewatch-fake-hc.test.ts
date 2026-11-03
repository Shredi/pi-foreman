// End to end on the fake hc (tests/fakes/hc.py): the watcher follows the fake's `hc events --json` stream (snapshot, JSON-RPC
// events, heartbeats); a child's `remote notice plan` sets the label while it follows, the watcher fetches plan.md with
// `hc file read` and mirrors it. POSIX only (the fake is installed as a shell script).
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

test("child `remote notice plan` on the fake hc while the watcher follows the event stream → mirrored plan.md and a wake", { skip: process.platform === "win32" ? "the test starts `python3` and names the shim `hc`; on win32 the fake is `hc.cmd` and python is `python`" : false }, async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-rwatch-e2e-")));
  const state = path.join(root, "hcstate");
  const handoff = path.join(state, "handoff", "20261103-120000-demo");
  fs.mkdirSync(handoff, { recursive: true });
  fs.writeFileSync(path.join(handoff, "plan.md"), "# Plan\n1. do it \u6f22\n");
  fs.writeFileSync(path.join(handoff, "child"), `${CHILD}\n`);
  fs.writeFileSync(path.join(handoff, "parent"), "opener-1@gamma\n");
  fs.writeFileSync(path.join(state, "terminals.json"), JSON.stringify({ "alpha/t1": { address: "alpha/t1", labels: {}, state: "live", status: { app: "pi", state: "working" } } }));
  const bin = path.join(root, "bin");
  execFileSync("python3", ["-c", "import sys; sys.path.insert(0, sys.argv[1]); import hc_install; hc_install.install_fake_hc(sys.argv[2])", path.join(repo, "tests", "fakes"), bin]);
  const childAgent = path.join(root, "child-agent");
  writeRegistry(childAgent, { version: 1, sessions: [{ label: "demo", child: CHILD, status: "open", handoff }] });
  const log = path.join(root, "hc.log");
  const env = { ...process.env, HC_BIN: path.join(bin, "hc"), FAKE_HC_STATE: state, HC_TERMINAL_ID: "alpha/t1", PI_FOREMAN_REMOTE_PARENT: "1", PI_FOREMAN_HANDOFF_DIR: handoff };

  const agent = path.join(root, "agent");
  const mirror = path.join(agent, "pi-foreman", "remote", "alpha", "20261103-120000-demo");
  writeRegistry(agent, {
    version: 1,
    sessions: [{ label: "demo", child: CHILD, parent: "opener-1", status: "open", machine: "alpha", originMachine: "alpha", remoteHandoff: handoff, mirror, handoff: mirror, backend: "hc", hc: { address: "alpha/t1" }, remote: { platform: "linux" }, briefs: 0 }],
  });
  const saved = { HC_BIN: process.env.HC_BIN, FAKE_HC_STATE: process.env.FAKE_HC_STATE, FAKE_HC_EVENTS_FOLLOW: process.env.FAKE_HC_EVENTS_FOLLOW, FAKE_HC_LOG: process.env.FAKE_HC_LOG };
  process.env.HC_BIN = env.HC_BIN;
  process.env.FAKE_HC_STATE = state;
  process.env.FAKE_HC_EVENTS_FOLLOW = "30";
  process.env.FAKE_HC_LOG = log;
  const wakes: string[] = [];
  const w = new RemoteWatcher({ agentDir: agent, opener: () => "opener-1", wake: (l, k, t) => wakes.push(`child ${l}: ${k} ${t}`) });
  try {
    w.start();
    for (let i = 0; i < 100 && !(readRegistry(agent).sessions[0].remoteLive); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal((readRegistry(agent).sessions[0].remoteLive as { state: string }).state, "working", "the first hc get");
    await new Promise((r) => setTimeout(r, 500)); // the stream is following
    const out = execFileSync("python3", ["-E", "-s", path.join(repo, "scripts", "foreman_session.py"), "--agent-dir", childAgent, "remote", "notice", "plan"], { env, encoding: "utf8" });
    assert.equal((JSON.parse(out) as { seq: number }).seq, 1);
    for (let i = 0; i < 100 && !wakes.length; i++) await new Promise((r) => setTimeout(r, 50));
    await w.idle();
  } finally {
    w.stop();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.deepEqual(wakes, [`child demo: plan ${path.join(mirror, "plan.md")}`]);
  assert.equal(fs.readFileSync(path.join(mirror, "plan.md"), "utf8"), "# Plan\n1. do it \u6f22\n");
  const e = readRegistry(agent).sessions[0];
  assert.equal(e.noticeSeq, 1);
  assert.equal(e.lastError, null);
  const calls = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
  assert.equal(calls.filter((c) => c[0] === "get").length, 1, "the label came over the stream, not a poll");
  assert.ok(calls.some((c) => c[0] === "events"));
});
