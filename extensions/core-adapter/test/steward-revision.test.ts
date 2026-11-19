// Steward revision: standing ledger step, retro counters tool action, maxProposals in the sent text, store .gitignore, trace fields, refusals, tick safety, concurrent lesson emit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordReport, setState, storeFor, readRows, type Writer } from "../reports.ts";
import { retroCounters } from "../reportstool.ts";
import { STEWARD_TEXT_TYPE, StewardWatch, lockFileOf, stewardSettings, wakeText, type StewardDeps } from "../steward.ts";
import { sanitizeTrace } from "../trace.ts";
import { boundLedger } from "../marker.ts";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";
import { r11Rig } from "./_r11rig.ts";

process.env.PI_OFFLINE = "1";
const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const skip = !py.ok ? "no Python >= 3.13" : false;

type T = { after(fn: () => void | Promise<void>): void };
const INSTRUCTION = fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "..", "instructions", "steward.md"), "utf8");
function tmp(t: T): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-steward-rev-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const w = (cwd: string, session: string): Writer => ({ cwd, role: "foreman", session, runId: null, source: "agent", repo: null, workspace: null, branch: null });

function watch(cwd: string, over: Record<string, unknown> = {}, extra: Partial<StewardDeps> = {}) {
  const sent: string[] = [];
  const traces: Record<string, unknown>[] = [];
  const wakes: string[] = [];
  let tick: (() => void) | null = null;
  const deps: StewardDeps = {
    cwd: () => cwd,
    settings: () => stewardSettings({ steward: { enabled: true, ...over } }),
    now: () => Date.now(),
    timers: { set: (fn) => ((tick = fn), 1), clear: () => void (tick = null) },
    piSessionId: () => "pi-1",
    persist: () => undefined,
    sendText: (x) => void sent.push(x),
    sendWake: (x) => void wakes.push(x),
    idle: () => true,
    instruction: () => INSTRUCTION,
    trace: (x) => void traces.push(x),
    notice: () => undefined,
    ...extra,
  };
  return { watch: new StewardWatch(deps), sent, traces, wakes, fire: () => tick?.(), armed: () => tick !== null };
}

test("the instruction binds the standing ledger before it launches the helper, and reads the counters from the tool", () => {
  const ledger = INSTRUCTION.indexOf("foreman_ledger");
  const launch = INSTRUCTION.indexOf('model: "top"');
  assert.ok(ledger > 0 && launch > ledger, "ledger step first");
  assert.match(INSTRUCTION, /topic `steward`/);
  assert.match(INSTRUCTION, /in every pass/);
  assert.match(INSTRUCTION, /action `retro`/);
  assert.ok(!INSTRUCTION.includes("read it from the config"));
  assert.ok(INSTRUCTION.includes("{maxProposals}"));
});

for (const [configured, want] of [[1, "at most 1 rounds"], [5, "at most 5 rounds"], [undefined, "at most 3 rounds"]] as const) {
  test(`maxProposals ${configured ?? "default"} is in the instruction text that is sent`, (t) => {
    const dir = tmp(t);
    const r = watch(dir, configured === undefined ? {} : { maxProposals: configured });
    assert.equal(r.watch.on().ok, true);
    assert.equal(r.sent.length, 1);
    assert.ok(r.sent[0].includes(want), r.sent[0]);
    assert.ok(!r.sent[0].includes("{maxProposals}"));
  });
}

test("on creates the store through ensureDir: a fresh git repo shows nothing under .workflow/reports", (t) => {
  const dir = tmp(t);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const r = watch(dir);
  assert.equal(r.watch.on().ok, true);
  assert.equal(fs.existsSync(lockFileOf(dir)), true);
  assert.equal(fs.readFileSync(path.join(storeFor(dir).dir, ".gitignore"), "utf8"), "*\n");
  const status = execFileSync("git", ["status", "--porcelain", "--", ".workflow/reports"], { cwd: dir, encoding: "utf8" });
  assert.equal(status, "");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).includes("steward.lock"), false);
});

test("the trace keeps ranked, fresh and open as written", () => {
  assert.deepEqual(sanitizeTrace({ event: "launch_top", role: "explorer", model: "p/m", ranked: true }), { event: "launch_top", role: "explorer", model: "p/m", ranked: true });
  assert.deepEqual(sanitizeTrace({ event: "steward", action: "wake", fresh: 3, open: 7 }), { event: "steward", action: "wake", fresh: 3, open: 7 });
});

test("the wake text holds counts only and points at no path", () => {
  const text = wakeText({ wake: true, fresh: 2, open: 4 });
  assert.ok(!/steward\.md|read it again/.test(text), text);
  assert.match(text, /2 new open reports/);
});

test("a throw inside a tick is traced and the timer keeps running", (t) => {
  const dir = tmp(t);
  let boom = true;
  const r = watch(dir, { minNew: 3 }, { idle: () => { if (boom) throw new Error("SECRET-PATH /home/x"); return true; } });
  r.watch.on();
  for (let i = 0; i < 3; i++) recordReport({ ...w(dir, `s${i}`), now: Date.now() + 60_000 }, { kind: "rule", subject: `guard ${i}`, what: "SECRET it blocked", effect: "blocked" });
  assert.doesNotThrow(() => r.fire());
  const failed = r.traces.filter((x) => x.action === "tick_failed");
  assert.equal(failed.length, 1);
  assert.ok(!JSON.stringify(failed).includes("SECRET"));
  assert.equal(r.armed(), true, "timer re-armed");
  boom = false;
  r.fire();
  assert.equal(r.wakes.length, 1, "the next tick works");
});

test("retroCounters drops the permission proposals and passes non-JSON through", () => {
  const out = JSON.parse(retroCounters(JSON.stringify({ usage: { n: 1 }, proposals: [{ family: "x" }] }))) as Record<string, unknown>;
  assert.deepEqual(out, { usage: { n: 1 } });
  assert.equal(retroCounters("no data"), "no data");
});

type Res = { content: { text: string }[]; isError?: boolean };
async function adapterRig(t: T, child = false, config: Record<string, unknown> = { steward: { enabled: true } }) {
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<Res> }>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const notes: string[] = [];
  const sent: { customType: string; content: string }[] = [];
  const a = await r11Rig(t, { ledgerHelper: "tool" }, {
    child,
    config: { presence: { enabled: false }, ...config },
    ctx: { ui: { notify: (m: string) => notes.push(m), confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined } },
    piExtra: {
      registerTool: (d: { name: string; execute: never }) => void tools.set(d.name, d as never),
      registerCommand: (n: string, d: never) => void commands.set(n, d),
      sendMessage: (m: { customType: string; content: string }) => void sent.push(m),
      appendEntry: () => undefined,
    },
  });
  const call = async (name: string, params: Record<string, unknown>) => {
    const r = await tools.get(name)!.execute("id", params, undefined, undefined, a.ctx);
    return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
  };
  return { a, notes, sent, call, command: (args: string) => commands.get("foreman")!.handler(args, a.ctx) };
}

test("a steward session launches the top explorer with a long brief once the standing ledger is bound, in every pass", { skip }, async (t) => {
  const r = await adapterRig(t);
  await r.command("steward on");
  const brief = `Groups and counters. ${"detail ".repeat(400)}`;
  const top = { agent: "explorer", task: brief, model: "top", reason: "steward pass" };
  const before = await r.a.launch({ ...top });
  assert.equal(before.res?.block, true, "no ledger: the spawn gate refuses");
  assert.ok(!/top_not_allowed/.test(before.res?.reason ?? ""), before.res?.reason);
  const init = await r.call("foreman_ledger", { action: "init", topic: "steward", texts: ["Steward passes: group the open reports, check them, report, propose rounds"] });
  assert.equal(init.isError, false, init.text);
  for (let pass = 0; pass < 2; pass++) {
    const res = (await r.a.launch({ ...top })).res;
    assert.equal(res, undefined, `pass ${pass}: ${res?.reason}`);
  }
  assert.ok(boundLedger(path.join(r.a.agentDir, "pi-foreman", "state"), r.a.sessionId));
});

test("foreman_reports retro runs the retro inputs of the session and returns counters without proposals", { skip }, async (t) => {
  const r = await adapterRig(t);
  await r.command("steward on");
  const out = await r.call("foreman_reports", { action: "retro" });
  assert.equal(out.isError, false, out.text);
  const j = JSON.parse(out.text) as Record<string, unknown>;
  assert.ok("usage" in j && "trace" in j);
  assert.ok(!("proposals" in j));
});

test("foreman_reports retro is refused in a child", async (t) => {
  const r = await adapterRig(t, true);
  const out = await r.call("foreman_reports", { action: "retro" });
  assert.equal(out.isError, true);
  assert.match(out.text, /foreman session only/);
});

test("/foreman steward on is refused in a child session", async (t) => {
  const r = await adapterRig(t, true);
  await r.command("steward on");
  assert.match(r.notes.at(-1) ?? "", /a child or a session a parent opened cannot be it/);
  assert.equal(r.sent.filter((m) => m.customType === STEWARD_TEXT_TYPE).length, 0);
  assert.equal(fs.existsSync(lockFileOf(r.a.project)), false);
});

test("/foreman steward on is refused in a session a parent opened", async (t) => {
  const saved = process.env.PI_FOREMAN_HANDOFF_DIR;
  t.after(() => (saved === undefined ? delete process.env.PI_FOREMAN_HANDOFF_DIR : (process.env.PI_FOREMAN_HANDOFF_DIR = saved)));
  const r = await adapterRig(t);
  process.env.PI_FOREMAN_HANDOFF_DIR = r.a.handoff("opened-by-parent", "child");
  await r.command("steward on");
  assert.match(r.notes.at(-1) ?? "", /a child or a session a parent opened cannot be it/);
  assert.equal(r.sent.filter((m) => m.customType === STEWARD_TEXT_TYPE).length, 0);
  assert.equal(fs.existsSync(lockFileOf(r.a.project)), false);
});

test("sessions that start at the same moment emit each pending lesson once", async (t) => {
  const dir = tmp(t);
  for (const name of ["alpha", "beta", "gamma"]) {
    recordReport(w(dir, "a"), { kind: "rule", subject: name, what: "text", effect: "blocked" });
  }
  const store = storeFor(dir);
  // The CLI path: lessons appended without an emit (setState with a lesson, no claim).
  const keys = readRows(store.file).filter((x) => x.row === "report").map((x) => String(x.key));
  for (const [i, k] of keys.entries()) setState(store, k, { state: "done", pr: 3, lesson: `Lesson number ${i}.` }, "cli");
  const script = path.join(import.meta.dirname, "_emit-pending-proc.ts");
  const runs = await Promise.all(Array.from({ length: 6 }, () => new Promise<number>((resolve, reject) => {
    const p = spawn(process.execPath, [script, dir], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", () => resolve(Number(out.trim())));
  })));
  assert.equal(runs.reduce((a, b) => a + b, 0), 3, `each lesson once: ${runs.join(",")}`);
});
