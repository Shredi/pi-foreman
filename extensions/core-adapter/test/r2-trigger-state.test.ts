// Security re-check round 2: the drift state folder is protected, and a missing, truncated or
// corrupt stored snapshot for a workspace that had one is drift, not a silent fresh baseline
// (R2-M1). A true first session is reported (firstBaseline). Temp dirs only, removed on that path.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { GitDriftWatch } from "../gitdrift.ts";
import { ClaudeConfigWatch } from "../claudedrift.ts";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HOME = os.tmpdir();
const PRINT = { mode: "print", hasUI: false };
const noTrace = () => undefined;

function tmp(t: { after(fn: () => void): void }, prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeRepo(dir: string): void {
  fs.mkdirSync(path.join(dir, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "config"), "[core]\n\tbare = false\n");
}

const only = (state: string, prefix: string): string => {
  const [f] = fs.readdirSync(state).filter((n) => n.startsWith(prefix) && n.endsWith(".json"));
  assert.ok(f, `no ${prefix} snapshot in ${state}`);
  return path.join(state, f);
};

test("R2-M1: a true first session takes the baseline visibly and writes a seen marker", async (t) => {
  const state = tmp(t, "pf-r2s-");
  const dir = tmp(t, "pf-r2w-");
  fakeRepo(dir);
  const g = new GitDriftWatch();
  const c = new ClaudeConfigWatch();
  assert.deepEqual(g.bind(state, dir, HOME), []);
  assert.deepEqual(c.bind(state, dir), []);
  assert.equal(g.firstBaseline, true);
  assert.equal(c.firstBaseline, true);
  assert.deepEqual(fs.readdirSync(state).filter((n) => n.endsWith(".seen")).length, 2);
  const g2 = new GitDriftWatch();
  const c2 = new ClaudeConfigWatch();
  assert.deepEqual(g2.bind(state, dir, HOME), []);
  assert.deepEqual(c2.bind(state, dir), []);
  assert.equal(g2.firstBaseline || c2.firstBaseline, false, "second session is not a first session");
  assert.equal(await g2.gate(dir, HOME, "x", PRINT, noTrace), undefined);
  assert.equal(await c2.check(dir, "x", PRINT, noTrace), undefined);
});

for (const [name, damage] of [
  ["deleted", (f: string) => fs.unlinkSync(f)],
  ["truncated", (f: string) => fs.writeFileSync(f, fs.readFileSync(f, "utf8").slice(0, 9))],
  ["garbage", (f: string) => fs.writeFileSync(f, '{"v":1,"files":"nope"}')],
] as const) {
  test(`R2-M1: a ${name} snapshot for a workspace that had one is drift (blocked without UI; approve re-baselines)`, async (t) => {
    const state = tmp(t, "pf-r2s-");
    const dir = tmp(t, "pf-r2w-");
    fakeRepo(dir);
    new GitDriftWatch().bind(state, dir, HOME);
    new ClaudeConfigWatch().bind(state, dir);
    damage(only(state, "gitdrift-"));
    damage(only(state, "claudecfg-"));

    const g = new GitDriftWatch();
    const gl = g.bind(state, dir, HOME);
    assert.equal(g.firstBaseline, false);
    assert.equal(gl.length, 1);
    assert.match(gl[0], /stored git config snapshot .* (missing|unreadable|corrupt or truncated)/);
    assert.match((await g.gate(dir, HOME, "this git command", PRINT, noTrace))?.reason ?? "", /no UI.*pi-foreman state/s);
    const c = new ClaudeConfigWatch();
    const cl = c.bind(state, dir);
    assert.equal(c.firstBaseline, false);
    assert.match(cl.join("\n"), /stored Claude Code config snapshot/);
    assert.match((await c.check(dir, "this claude-bridge run", PRINT, noTrace))?.reason ?? "", /no UI.*pi-foreman state/s);
    assert.match((await c.check(dir, "x", { mode: "rpc", hasUI: true, confirm: async () => false }, noTrace))?.reason ?? "", /^Denied by the user/);

    // A later session still sees it until someone approves.
    const again = new ClaudeConfigWatch();
    assert.equal(again.bind(state, dir).length, 1);
    assert.equal(await again.check(dir, "x", { mode: "tui", hasUI: true, confirm: async () => true }, noTrace), undefined);
    assert.equal(await again.check(dir, "x", PRINT, noTrace), undefined, "approved: new baseline");
    assert.equal(await g.gate(dir, HOME, "x", { mode: "rpc", hasUI: true, confirm: async () => true }, noTrace), undefined);
    assert.deepEqual(new GitDriftWatch().bind(state, dir, HOME), []);
    assert.deepEqual(new ClaudeConfigWatch().bind(state, dir), []);
  });
}

test("R2-M1: the pi-foreman state folder is protected (foreman asked, child denied; file tools and shell words)", (t) => {
  const root = tmp(t, "pf-r2p-");
  const cwd = path.join(root, "proj");
  const home = path.join(root, "home");
  const agentDir = path.join(home, ".pi", "agent");
  const state = path.join(agentDir, "pi-foreman", "state");
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(cwd);
  const snap = path.join(state, "claudecfg-abc.json");
  fs.writeFileSync(snap, "{}");
  const r = buildOverlayRules(readBaseline(PKG)!, {}, {}, agentDir, path.join(root, "pkg"));
  const kind = (tool: string, input: Record<string, unknown>, role: "main" | "child"): string => checkToolCall(r, tool, input, { cwd, home, platform: process.platform, role })?.kind ?? "pass";
  for (const [tool, input] of [
    ["write", { path: snap, content: "{}" }],
    ["edit", { path: snap, edits: [] }],
    ["bash", { command: `echo x > ${snap}` }],
    ["bash", { command: `trash ${state}` }],
    ["bash", { command: "trash ~/.pi/agent/pi-foreman/state/claudecfg-abc.seen" }],
  ] as Array<[string, Record<string, unknown>]>) {
    assert.equal(kind(tool, input, "main"), "ask", `main ${tool} ${JSON.stringify(input)}`);
    assert.equal(kind(tool, input, "child"), "deny", `child ${tool} ${JSON.stringify(input)}`);
  }
});
