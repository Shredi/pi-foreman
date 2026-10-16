// pi-background-tasks compatibility with the running Pi (ledger items 8 and 9): the doctor's peer-range info line.
// Temp dirs only; the add-on is a fake package.json under the temp agent dir's npm root.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import coreAdapter, { type AdapterDeps } from "../index.ts";
import { addonPeerRangeLine, rangeAllows } from "../bg.ts";

const tmp = (t: { after(fn: () => void): void }, prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
let sessions = 0;

function fakeAddon(agentDir: string, peerDependencies: Record<string, string> | undefined): void {
  const dir = path.join(agentDir, "npm", "node_modules", "pi-background-tasks");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "pi-background-tasks", version: "0.0.1", ...(peerDependencies ? { peerDependencies } : {}) }));
}

function doctorHarness(t: { after(fn: () => void): void }, deps: AdapterDeps = {}, env: Record<string, string | undefined> = {}) {
  const keys = ["PATH", "Path", "PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "GIT_CONFIG_COUNT", ...Object.keys(env)];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
  const root = tmp(t, "pf-addon-");
  const project = path.join(root, "project");
  const agentDir = path.join(root, "x", "agent");
  fs.mkdirSync(path.join(project, ".workflow"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_SUBAGENT_CHILD;
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = {
    on: (n: string, h: Handler) => void handlers.set(n, h),
    registerCommand: (n: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => void commands.set(n, c),
    registerTool: () => undefined,
    getActiveTools: () => [] as string[],
    getAllTools: () => [{ name: "bash" }],
    setActiveTools: () => undefined,
    setModel: async () => true,
    setThinkingLevel: () => undefined,
    sendMessage: () => undefined,
  };
  coreAdapter(pi as never, deps);
  const notes: { text: string; level: string }[] = [];
  const sessionId = `addon-session-${++sessions}`;
  const ctx = {
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
    cwd: project,
    model: undefined,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    isIdle: () => true,
    modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
    ui: { notify: (m: string, level: string) => void notes.push({ text: m, level }), confirm: async () => false },
  };
  const doctor = async (): Promise<{ text: string; level: string }> => {
    await handlers.get("session_start")!({ reason: "startup" }, ctx);
    t.after(async () => handlers.get("session_shutdown")?.({}, ctx));
    await commands.get("foreman")!.handler("doctor", ctx);
    return notes.pop()!;
  };
  return { agentDir, project, doctor };
}

test("rangeAllows: caret, tilde, x-ranges, comparator sets and alternatives", () => {
  assert.equal(rangeAllows("^0.81.0", "0.81.4"), true);
  assert.equal(rangeAllows("^0.81.0", "0.82.0"), false);
  assert.equal(rangeAllows("^0.81.0 || ^0.84.0", "0.84.2"), true);
  assert.equal(rangeAllows("^0.81.0 || ^0.84.0", "1.2.0"), false);
  assert.equal(rangeAllows("1.2.x", "1.2.0"), true);
  assert.equal(rangeAllows("1.2.x", "1.3.0"), false);
  assert.equal(rangeAllows("^1.2.0", "1.9.9"), true);
  assert.equal(rangeAllows("~1.2.0", "1.3.0"), false);
  assert.equal(rangeAllows(">=0.81 <2", "1.2.0"), true);
  assert.equal(rangeAllows(">= 0.81.0 < 1.0.0", "1.2.0"), false);
  assert.equal(rangeAllows("*", "1.2.0"), true);
  assert.equal(rangeAllows("1.0.0 - 2.0.0", "1.2.0"), null);
  assert.equal(rangeAllows("^1.2.0", "not-a-version"), null);
});

test("addonPeerRangeLine: no add-on -> no line; range inside / outside / none declared", (t) => {
  const root = tmp(t, "pf-addon-line-");
  const dirs = { agentDir: path.join(root, "agent"), cwd: path.join(root, "proj") };
  assert.equal(addonPeerRangeLine(dirs, "1.2.0"), null);
  fakeAddon(dirs.agentDir, { "@earendil-works/pi-coding-agent": "^1.2.0" });
  assert.equal(addonPeerRangeLine(dirs, "1.2.0"), "INFO pi-background-tasks peer range for @earendil-works/pi-coding-agent: ^1.2.0; running Pi 1.2.0 is inside it");
  assert.equal(addonPeerRangeLine(dirs, null), "INFO pi-background-tasks peer range for @earendil-works/pi-coding-agent: ^1.2.0; running Pi version unknown");
  fakeAddon(dirs.agentDir, undefined);
  assert.equal(addonPeerRangeLine(dirs, "1.2.0"), "INFO pi-background-tasks peer range for @earendil-works/pi-coding-agent: none declared");
});

test("doctor: an add-on whose peer range excludes the running Pi prints an INFO line; the outcome level is unchanged", async (t) => {
  const base = doctorHarness(t, { piVersion: async () => "1.2.0" });
  const before = await base.doctor();
  assert.doesNotMatch(before.text, /peer range/, "absent add-on: no line");
  const h = doctorHarness(t, { piVersion: async () => "1.2.0" });
  fakeAddon(h.agentDir, { "@earendil-works/pi-coding-agent": "^0.81.0 || ^0.84.0" });
  const r = await h.doctor();
  const line = r.text.split("\n").find((l) => l.includes("peer range"));
  assert.equal(line, "INFO pi-background-tasks peer range for @earendil-works/pi-coding-agent: ^0.81.0 || ^0.84.0; running Pi 1.2.0 is outside it (npm may warn on install; check for a newer pi-background-tasks)");
  assert.equal(r.level, before.level, "an info line never changes the doctor's outcome");
  const fails = (s: string) => s.split("\n").filter((l) => l.startsWith("FAIL"));
  assert.deepEqual(fails(r.text), fails(before.text));
});
