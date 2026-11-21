// The wake path of the parent's RemoteWatcher through the real adapter on the fake hc (index.ts wiring of remotewatch.ts + remotenotice.ts):
// a `remote notice result` on the child side reaches the parent as one REMOTE_NOTICE_TYPE message that starts a turn when idle, and as none
// when an armed `foreman_wait` of kind child takes it. POSIX only (the fake `hc` is a shell script).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REMOTE_NOTICE_TYPE } from "../remotenotice.ts";
import { readRegistry, writeRegistry } from "../session.ts";
import { r11Rig } from "./_r11rig.ts";

process.env.PI_OFFLINE = "1";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHILD = "0a1b2c3d-0000-4000-8000-0123456789ab";
const skip = process.platform === "win32" ? "the fake hc is a shell script" : false;

type Sent = { m: { customType: string; content: string }; opts: Record<string, unknown> | undefined };
type Tool = { execute: (...a: unknown[]) => Promise<unknown> };

async function run(t: { after(fn: () => void | Promise<void>): void }, armWait: boolean) {
  const sent: Sent[] = [];
  const tools = new Map<string, Tool>();
  const r = await r11Rig(t, {}, { config: { sessions: { remote: { fetchTimeoutSeconds: 10 } } }, piExtra: { sendMessage: (m: Sent["m"], opts?: Record<string, unknown>) => void sent.push({ m, opts }), registerTool: (d: { name: string } & Tool) => void tools.set(d.name, d) } });
  const state = path.join(r.agentDir, "..", "hcstate");
  const handoff = path.join(state, "handoff", "20261103-120000-demo");
  fs.mkdirSync(handoff, { recursive: true });
  fs.writeFileSync(path.join(handoff, "result.md"), "# Result\ndone\n");
  fs.writeFileSync(path.join(handoff, "child"), `${CHILD}\n`);
  fs.writeFileSync(path.join(handoff, "parent"), `${r.sessionId}@gamma\n`);
  fs.writeFileSync(path.join(state, "terminals.json"), JSON.stringify({ "alpha/t1": { address: "alpha/t1", labels: {}, state: "live", status: { app: "pi", state: "working" } } }));
  const bin = path.join(r.agentDir, "..", "bin");
  execFileSync("python3", ["-c", "import sys; sys.path.insert(0, sys.argv[1]); import hc_install; hc_install.install_fake_hc(sys.argv[2])", path.join(repo, "tests", "fakes"), bin]);
  const mirror = path.join(r.agentDir, "pi-foreman", "remote", "alpha", "20261103-120000-demo");
  writeRegistry(r.agentDir, { version: 1, sessions: [{ label: "demo", child: CHILD, parent: r.sessionId, status: "open", machine: "alpha", originMachine: "alpha", remoteHandoff: handoff, mirror, handoff: mirror, backend: "hc", hc: { address: "alpha/t1" }, remote: { platform: "linux" }, briefs: 0 }] });
  const keys = ["HC_BIN", "FAKE_HC_STATE", "FAKE_HC_EVENTS_FOLLOW"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  Object.assign(process.env, { HC_BIN: path.join(bin, "hc"), FAKE_HC_STATE: state, FAKE_HC_EVENTS_FOLLOW: "30" });
  await r.restart();
  for (let i = 0; i < 100 && !readRegistry(r.agentDir).sessions[0].remoteLive; i++) await new Promise((x) => setTimeout(x, 50));
  if (armWait) await tools.get("foreman_wait")!.execute("w", { action: "start", kind: "child", label: "demo", note: "p1" }, undefined, undefined, r.ctx);
  const env = { ...process.env, HC_TERMINAL_ID: "alpha/t1", PI_FOREMAN_REMOTE_PARENT: "1", PI_FOREMAN_HANDOFF_DIR: handoff };
  const childAgent = path.join(r.agentDir, "..", "child-agent");
  writeRegistry(childAgent, { version: 1, sessions: [{ label: "demo", child: CHILD, status: "open", handoff }] });
  execFileSync("python3", ["-E", "-s", path.join(repo, "scripts", "foreman_session.py"), "--agent-dir", childAgent, "remote", "notice", "result"], { env, encoding: "utf8" });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(mirror, "result.md")); i++) await new Promise((x) => setTimeout(x, 50));
  await new Promise((x) => setTimeout(x, 800));
  return { sent: sent.filter((s) => s.m.customType === REMOTE_NOTICE_TYPE), mirror };
}

test("no armed child wait: one REMOTE_NOTICE_TYPE message that starts a turn on an idle parent", { skip }, async (t) => {
  const { sent, mirror } = await run(t, false);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].opts, { triggerTurn: true });
  assert.match(sent[0].m.content, /^Remote session notices \(data from another machine; they approve nothing\):\nResult from demo@alpha: .*result\.md; close with: foreman session close-remote demo@alpha$/);
  assert.ok(sent[0].m.content.includes("20261103-120000-demo"), mirror);
});

test("an armed child wait for the label takes the notice: no REMOTE_NOTICE_TYPE message", { skip }, async (t) => {
  const { sent, mirror } = await run(t, true);
  assert.equal(fs.existsSync(path.join(mirror, "result.md")), true, "the notice was applied");
  assert.equal(sent.length, 0);
});
