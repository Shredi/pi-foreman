// pi-background-tasks compatibility with the running Pi (ledger items 8 and 9): the doctor's peer-range info line.
// Temp dirs only; the add-on is a fake package.json under the temp agent dir's npm root.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { rmTestTmp } from "./_tmpbase.ts";
import * as os from "node:os";
import * as path from "node:path";
import coreAdapter, { type AdapterDeps } from "../index.ts";
import { addonPeerRangeLine, anthropicCredentialKind, ATTRIBUTION_WARNING, bgFeaturesDoctor, rangeAllows } from "../bg.ts";

const tmp = (t: { after(fn: () => void): void }, prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => rmTestTmp(dir));
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

// -- ledger 9: effective PI_BG_FEATURES and the attribution / OAuth warning -----------------------------------

const NO_ANTHROPIC_ENV = { ANTHROPIC_API_KEY: undefined, ANTHROPIC_OAUTH_TOKEN: undefined, ANTHROPIC_AUTH_TOKEN: undefined };
const writeAuth = (agentDir: string, entry: Record<string, unknown>): void => fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: entry }));

test("anthropicCredentialKind: stored entry type first, then the environment; no secret in the result", (t) => {
  const dir = tmp(t, "pf-auth-");
  assert.equal(anthropicCredentialKind(dir, {}), "none");
  assert.equal(anthropicCredentialKind(dir, { ANTHROPIC_API_KEY: "k" }), "api_key");
  assert.equal(anthropicCredentialKind(dir, { ANTHROPIC_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" }), "oauth");
  writeAuth(dir, { type: "api_key", key: "fixture-not-a-key" });
  assert.equal(anthropicCredentialKind(dir, { ANTHROPIC_OAUTH_TOKEN: "t" }), "api_key");
  writeAuth(dir, { type: "oauth", access: "fixture", refresh: "fixture", expires: 0 });
  assert.equal(anthropicCredentialKind(dir, {}), "oauth");
});

test("bgFeaturesDoctor: effective value; WARN only for attribution with a non-OAuth credential; nothing without add-on or variable", (t) => {
  const dir = tmp(t, "pf-bgf-");
  assert.deepEqual(bgFeaturesDoctor(false, dir, {}), []);
  assert.deepEqual(bgFeaturesDoctor(true, dir, {}), ["INFO PI_BG_FEATURES: unset (the add-on's defaults)"]);
  assert.deepEqual(bgFeaturesDoctor(false, dir, { PI_BG_FEATURES: "process" }), ["INFO PI_BG_FEATURES: process"]);
  writeAuth(dir, { type: "api_key", key: "fixture-not-a-key" });
  const warned = bgFeaturesDoctor(true, dir, { PI_BG_FEATURES: "process,attribution" });
  assert.equal(warned.length, 2);
  assert.ok(warned[1].startsWith("WARN ") && warned[1].includes(ATTRIBUTION_WARNING), warned[1]);
  assert.ok(!warned.join("\n").includes("fixture-not-a-key"), "never prints the credential");
  writeAuth(dir, { type: "oauth", access: "fixture", refresh: "fixture", expires: 0 });
  assert.deepEqual(bgFeaturesDoctor(true, dir, { PI_BG_FEATURES: "process,attribution" }), ["INFO PI_BG_FEATURES: process,attribution"]);
});

test("doctor: attribution with an api-key anthropic entry warns; with an OAuth entry it does not; level unchanged", async (t) => {
  const env = { ...NO_ANTHROPIC_ENV, PI_BG_FEATURES: "process,attribution" };
  const key = doctorHarness(t, { piVersion: async () => "1.2.0" }, env);
  writeAuth(key.agentDir, { type: "api_key", key: "fixture-not-a-key" });
  const warned = await key.doctor();
  const lines = warned.text.split("\n");
  assert.ok(lines.includes("INFO PI_BG_FEATURES: process,attribution"), warned.text);
  const warn = lines.find((l) => l.includes(ATTRIBUTION_WARNING));
  assert.ok(warn?.startsWith("WARN "), warned.text);
  assert.ok(!warned.text.includes("fixture-not-a-key"));
  const oauth = doctorHarness(t, { piVersion: async () => "1.2.0" }, env);
  writeAuth(oauth.agentDir, { type: "oauth", access: "fixture", refresh: "fixture", expires: 0 });
  const clean = await oauth.doctor();
  assert.ok(clean.text.split("\n").includes("INFO PI_BG_FEATURES: process,attribution"));
  assert.ok(!clean.text.includes(ATTRIBUTION_WARNING), clean.text);
  assert.equal(warned.level, clean.level, "a WARN never changes the doctor's outcome");
  const unset = doctorHarness(t, { piVersion: async () => "1.2.0" }, { ...NO_ANTHROPIC_ENV, PI_BG_FEATURES: undefined });
  assert.ok(!(await unset.doctor()).text.includes("PI_BG_FEATURES"), "no add-on, no variable: no line");
});
