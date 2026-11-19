// The watcher's report import through the real adapter on the fake hc (index.ts importReports, remotewatch.ts fetchReports): `retro.report: false` turns
// the whole step off (no fetch, no mirror, no import); with the default the file is mirrored and one `reports_import` record carries the counts.
// POSIX only (the fake `hc` is a shell script).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readRows, storeFor } from "../reports.ts";
import { readRegistry, writeRegistry } from "../session.ts";
import { r11Rig } from "./_r11rig.ts";

process.env.PI_OFFLINE = "1";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHILD = "0a1b2c3d-0000-4000-8000-0123456789ab";
const ROW = JSON.stringify({ row: "report", id: "00000000a1", kind: "rule", subject: "guard x", what: "it blocked a read", effect: "blocked", repo: "acme/app", session: "remote-s1", ts: new Date().toISOString() });
const skip = process.platform === "win32" ? "the fake hc is a shell script" : false;

async function run(t: { after(fn: () => void | Promise<void>): void }, config: Record<string, unknown>) {
  const r = await r11Rig(t, {}, { config: { ...config, sessions: { remote: { fetchTimeoutSeconds: 10 } } } });
  const state = path.join(r.agentDir, "..", "hcstate");
  const handoff = path.join(state, "handoff", "20261103-120000-demo");
  fs.mkdirSync(handoff, { recursive: true });
  fs.writeFileSync(path.join(handoff, "result.md"), "# Result\ndone\n");
  fs.writeFileSync(path.join(handoff, "reports.jsonl"), `${ROW}\n`);
  fs.writeFileSync(path.join(handoff, "child"), `${CHILD}\n`);
  fs.writeFileSync(path.join(handoff, "parent"), `${r.sessionId}@gamma\n`);
  fs.writeFileSync(path.join(state, "terminals.json"), JSON.stringify({ "alpha/t1": { address: "alpha/t1", labels: {}, state: "live", status: { app: "pi", state: "working" } } }));
  const bin = path.join(r.agentDir, "..", "bin");
  execFileSync("python3", ["-c", "import sys; sys.path.insert(0, sys.argv[1]); import hc_install; hc_install.install_fake_hc(sys.argv[2])", path.join(repo, "tests", "fakes"), bin]);
  const mirror = path.join(r.agentDir, "pi-foreman", "remote", "alpha", "20261103-120000-demo");
  writeRegistry(r.agentDir, { version: 1, sessions: [{ label: "demo", child: CHILD, parent: r.sessionId, status: "open", machine: "alpha", originMachine: "alpha", remoteHandoff: handoff, mirror, handoff: mirror, backend: "hc", hc: { address: "alpha/t1" }, remote: { platform: "linux" }, briefs: 0 }] });
  const log = path.join(r.agentDir, "..", "hc.log");
  const keys = ["HC_BIN", "FAKE_HC_STATE", "FAKE_HC_EVENTS_FOLLOW", "FAKE_HC_LOG"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  Object.assign(process.env, { HC_BIN: path.join(bin, "hc"), FAKE_HC_STATE: state, FAKE_HC_EVENTS_FOLLOW: "30", FAKE_HC_LOG: log });
  await r.restart(); // the watcher starts with the registry written above
  for (let i = 0; i < 100 && !readRegistry(r.agentDir).sessions[0].remoteLive; i++) await new Promise((x) => setTimeout(x, 50));
  await new Promise((x) => setTimeout(x, 500));
  const env = { ...process.env, HC_TERMINAL_ID: "alpha/t1", PI_FOREMAN_REMOTE_PARENT: "1", PI_FOREMAN_HANDOFF_DIR: handoff };
  const childAgent = path.join(r.agentDir, "..", "child-agent");
  writeRegistry(childAgent, { version: 1, sessions: [{ label: "demo", child: CHILD, status: "open", handoff }] });
  execFileSync("python3", ["-E", "-s", path.join(repo, "scripts", "foreman_session.py"), "--agent-dir", childAgent, "remote", "notice", "result"], { env, encoding: "utf8" });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(mirror, "result.md")); i++) await new Promise((x) => setTimeout(x, 50));
  await new Promise((x) => setTimeout(x, 800)); // the fetch follows the wake
  const calls = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
  return { r, mirror, reads: calls.filter((c) => c[0] === "file" && String(c[4]).endsWith("reports.jsonl")).length };
}

test("retro.report false: the watcher fetches, mirrors and imports no report file", { skip }, async (t) => {
  const { r, mirror, reads } = await run(t, { retro: { report: false } });
  assert.equal(fs.existsSync(path.join(mirror, "result.md")), true, "the notice itself still works");
  assert.equal(reads, 0, "no fetch");
  assert.equal(fs.existsSync(path.join(mirror, "reports.jsonl")), false, "no mirror");
  assert.equal(fs.existsSync(storeFor(r.project).file), false, "no import");
  assert.equal(r.events("reports_import").length, 0);
});

test("default config: the file is mirrored and one reports_import record with counts reaches the trace file", { skip }, async (t) => {
  const { r, mirror, reads } = await run(t, {});
  assert.equal(reads, 1);
  assert.equal(fs.readFileSync(path.join(mirror, "reports.jsonl"), "utf8"), `${ROW}\n`);
  const ev = r.events("reports_import");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].lines, 1);
  assert.equal(ev[0].otherRepo, 1, "the temp project has no repository: no row matches");
  assert.equal(ev[0].added, 0);
  assert.deepEqual(readRows(storeFor(r.project).file), []);
});
