import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import coreAdapter from "../index.ts";
import { ClaudeUsageHook, StripSampler, stripClaudePath, stripLeasePath, stripPath } from "../strip.ts";
import type { StripDeps, StripDoc } from "../strip.ts";
import { HOUR_MS } from "../strip-model.ts";
import type { CpuTimes, StatFs } from "../strip-model.ts";
import type { StatusRunResult } from "../extstatus.ts";
import type { Timers } from "../prwatch.ts";
import { pressurePath } from "../pressure.ts";
import { withFileLock } from "../statefile.ts";
import { probeSpawner } from "./_probe-memo.ts";
import { mkTestTmp, rmTestTmp, waitQuiet } from "./_tmpbase.ts";

const win = process.platform === "win32";
const MB = 1024 * 1024;
const GB = 1024 ** 3;
const T0 = Date.parse("2026-03-01T10:00:00Z");
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const cpu = (busy: number, idle: number): CpuTimes[] => [{ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }];
const fsGB = (freeGB: number, totalGB = 100): StatFs => ({ bsize: 4096, blocks: (totalGB * GB) / 4096, bfree: (freeGB * GB) / 4096, bavail: (freeGB * GB) / 4096 });

interface Opts {
  config?: unknown;
  statfs?: StripDeps["statfs"];
  platform?: string;
  reply?: (program: string) => Partial<StatusRunResult>;
}

function rig(o: Opts = {}) {
  const root = mkTestTmp("pf-strip-");
  const agentDir = path.join(root, "agent");
  const ws = path.join(root, "ws");
  const bin = path.join(root, "bin");
  for (const d of [agentDir, ws, bin]) fs.mkdirSync(d, { recursive: true });
  const tool = path.join(bin, "usagecmd");
  fs.writeFileSync(tool, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const clock = { now: T0 };
  const cfg = { value: o.config ?? {} };
  const snap = { value: cpu(0, 0) };
  const traces: Record<string, unknown>[] = [];
  const runs: { program: string; args: string[] }[] = [];
  const timers: { fn: () => void; live: boolean }[] = [];
  const fake: Timers = { set: (fn) => (timers.push({ fn, live: true }), timers.length - 1), clear: (h) => void (typeof h === "number" && timers[h] && (timers[h].live = false)) };
  const reply = { fn: o.reply ?? ((): Partial<StatusRunResult> => ({ stdout: "[]" })) };
  const mk = (over: Partial<StripDeps> = {}): StripSampler =>
    new StripSampler({
      agentDir,
      diskPath: () => ws,
      workspace: () => ws,
      cwd: () => ws,
      sessionId: () => "s1",
      config: () => cfg.value,
      env: { PATH: bin },
      platform: o.platform ?? process.platform,
      trace: (r) => void traces.push(r),
      cpus: () => snap.value,
      totalmem: () => 16384 * MB,
      freemem: () => 4096 * MB,
      statfs: o.statfs ?? (() => fsGB(52)),
      now: () => clock.now,
      timers: fake,
      spawner: async (program, args) => {
        runs.push({ program, args });
        return { code: 0, stdout: "[]", stderr: "", overflow: false, timedOut: false, ...reply.fn(program) };
      },
      ...over,
    });
  const read = (): StripDoc => JSON.parse(fs.readFileSync(stripPath(agentDir), "utf8")) as StripDoc;
  const exists = (): boolean => fs.existsSync(stripPath(agentDir));
  const advance = (ms: number): void => void (clock.now += ms);
  return { root, agentDir, ws, bin, tool, clock, cfg, snap, traces, runs, timers, reply, mk, read, exists, advance, done: () => rmTestTmp(root) };
}
const strip = (c: unknown): unknown => ({ sidebar: { strip: c } });
const hdrs = (w: string, used: string, reset: string | number): Record<string, string> => ({ [`anthropic-ratelimit-unified-${w}-utilization`]: used, [`anthropic-ratelimit-unified-${w}-reset`]: String(reset) });

test("cpu: the first tick has no value, the next a delta, history capped at sparkline; schema version and no temp file left", (t) => {
  const r = rig({ config: strip({ sparkline: 3 }) });
  t.after(r.done);
  const s = r.mk();
  r.snap.value = cpu(0, 0);
  s.tick();
  assert.equal(r.read().version, 1);
  assert.equal(r.read().cpu?.pct, undefined);
  assert.deepEqual(r.read().cpu?.history, []);
  for (let i = 1; i <= 5; i++) {
    r.advance(10_000);
    r.snap.value = cpu(i * 50, i * 50);
    s.tick();
  }
  assert.equal(r.read().cpu?.pct, 50);
  assert.deepEqual(r.read().cpu?.history, [50, 50, 50]);
  assert.equal(r.read().sampleSeconds, 10);
  assert.equal(r.read().at, iso(r.clock.now));
  assert.deepEqual(fs.readdirSync(path.dirname(stripPath(r.agentDir))).filter((n) => n.endsWith(".tmp")), []);
});

test("memory: the guard's free memory when its sample is fresh, else the system's; tones", (t) => {
  const r = rig();
  t.after(r.done);
  const s = r.mk();
  s.tick();
  assert.equal(r.read().mem?.pct, 75, "os.freemem 4096 of 16384");
  fs.mkdirSync(path.dirname(pressurePath(r.agentDir)), { recursive: true });
  fs.writeFileSync(pressurePath(r.agentDir), JSON.stringify({ level: "ok", reasons: [], at: iso(r.clock.now), host: { freeMemMB: 8192 } }));
  r.advance(10_000);
  s.tick();
  assert.deepEqual(r.read().mem, { pct: 50, usedMB: 8192, totalMB: 16384, tone: "neutral" });
  r.advance(100_000);
  s.tick();
  assert.equal(r.read().mem?.pct, 75, "a stale sample is ignored");
  fs.writeFileSync(pressurePath(r.agentDir), JSON.stringify({ level: "ok", reasons: [], at: iso(r.clock.now), host: { freeMemMB: 400 } }));
  r.advance(10_000);
  s.tick();
  assert.equal(r.read().mem?.tone, "red");
});

test("level and cpu tone come from the guard's sample: reasons only at high or critical, stale is ok", (t) => {
  const r = rig();
  t.after(r.done);
  const s = r.mk();
  const put = (level: string, reasons: string[], host: unknown = {}): void => {
    fs.mkdirSync(path.dirname(pressurePath(r.agentDir)), { recursive: true });
    fs.writeFileSync(pressurePath(r.agentDir), JSON.stringify({ level, reasons, at: iso(r.clock.now), host }));
  };
  s.tick();
  assert.deepEqual(r.read().level, { level: "ok", reasons: [] }, "no sample");
  put("high", ["load"], { load1PerCore: 2 });
  r.advance(10_000);
  s.tick();
  assert.deepEqual(r.read().level, { level: "high", reasons: ["load"] });
  assert.equal(r.read().cpu?.tone, "amber");
  put("critical", ["load", "memory"], { load1PerCore: 3.5 });
  r.advance(10_000);
  s.tick();
  assert.deepEqual(r.read().level, { level: "critical", reasons: ["load", "memory"] });
  assert.equal(r.read().cpu?.tone, "red");
  put("ok", [], { load1PerCore: 0.2 });
  r.advance(10_000);
  s.tick();
  assert.deepEqual(r.read().level, { level: "ok", reasons: [] });
  r.advance(200_000);
  s.tick();
  assert.deepEqual(r.read().level, { level: "ok", reasons: [] });
  assert.equal(r.read().cpu?.tone, "neutral");
});

test("disks: default is the workspace, [] none, a missing path shows missing, never throws", (t) => {
  const seen: string[] = [];
  const r = rig({ statfs: (p) => (seen.push(p), p.includes("gone") ? (() => { throw new Error("ENOENT"); })() : fsGB(52)) });
  t.after(r.done);
  const s = r.mk();
  s.tick();
  assert.deepEqual(r.read().disks, [{ label: r.ws, usedPct: 48, freeGB: 52, tone: "neutral" }]);
  assert.deepEqual(seen, [r.ws]);
  r.cfg.value = strip({ disks: [] });
  r.advance(10_000);
  s.tick();
  assert.equal("disks" in r.read(), false);
  r.cfg.value = strip({ disks: ["/", "/gone"] });
  r.advance(10_000);
  s.tick();
  assert.deepEqual(r.read().disks, [{ label: "/", usedPct: 48, freeGB: 52, tone: "neutral" }, { label: "/gone", missing: true }]);
});

test("disks on win32: a bare drive letter is probed as its root", (t) => {
  const seen: string[] = [];
  const r = rig({ platform: "win32", config: strip({ disks: ["C:", "D:\\data"] }), statfs: (p) => (seen.push(p), fsGB(10)) });
  t.after(r.done);
  r.mk().tick();
  assert.deepEqual(seen, ["C:\\", "D:\\data"]);
  assert.deepEqual(r.read().disks?.map((d) => d.label), ["C:", "D:\\data"]);
});

test("a part switched off is absent from the file", (t) => {
  const r = rig({ config: strip({ cpu: false, memory: false, level: false, disks: [], quotas: { claude: false } }) });
  t.after(r.done);
  r.mk().tick();
  assert.deepEqual(Object.keys(r.read()).sort(), ["at", "samples", "sampleSeconds", "version"].sort());
});

test("enabled false starts no sampler and writes nothing", (t) => {
  const r = rig({ config: strip({ enabled: false }) });
  t.after(r.done);
  const s = r.mk();
  s.start();
  assert.equal(r.timers.length, 0);
  s.tick();
  assert.equal(r.exists(), false);
  assert.equal(fs.existsSync(stripLeasePath(r.agentDir)), false);
});

test("start arms a timer, ticks re-arm it, stop clears it and drops the lease", (t) => {
  const r = rig();
  t.after(r.done);
  const s = r.mk();
  s.start();
  assert.equal(r.timers.length, 1);
  r.timers[0].fn();
  assert.equal(r.exists(), true);
  assert.equal(r.timers.length, 2);
  assert.equal(fs.existsSync(stripLeasePath(r.agentDir)), true);
  void s.stop();
  assert.equal(r.timers[1].live, false);
  assert.equal(fs.existsSync(stripLeasePath(r.agentDir)), false);
  s.tick();
  assert.equal(s.holdsLease(), false);
});

test("lease: a live foreign lease means no measuring and no scripts; a stale one is taken; a renewal keeps it fresh", (t) => {
  const r = rig({ config: strip({ quotas: { sources: { credits: { command: "usagecmd" } } } }) });
  t.after(r.done);
  const lease = stripLeasePath(r.agentDir);
  fs.mkdirSync(path.dirname(lease), { recursive: true });
  fs.writeFileSync(lease, "foreign-token");
  fs.utimesSync(lease, r.clock.now / 1000, r.clock.now / 1000);
  const s = r.mk();
  s.tick();
  assert.equal(s.holdsLease(), false);
  assert.equal(r.exists(), false);
  assert.deepEqual(r.runs, []);
  r.advance(31_000); // 3 x 10 s
  s.tick();
  assert.equal(s.holdsLease(), true);
  assert.equal(r.exists(), true);
  assert.notEqual(fs.readFileSync(lease, "utf8"), "foreign-token");
  r.advance(10_000);
  s.tick();
  assert.equal(fs.statSync(lease).mtimeMs, r.clock.now);
  r.advance(10_000);
  s.tick();
  assert.equal(fs.statSync(lease).mtimeMs, r.clock.now);
  const other = r.mk();
  r.advance(10_000);
  s.tick();
  other.tick();
  assert.equal(other.holdsLease(), false, "the renewed lease stays with its holder");
});

test("lease: a holder that lost it stands by this tick and retakes on the next", (t) => {
  const r = rig();
  t.after(r.done);
  const s = r.mk();
  s.tick();
  assert.equal(s.holdsLease(), true);
  const lease = stripLeasePath(r.agentDir);
  fs.writeFileSync(lease, "stolen");
  fs.utimesSync(lease, r.clock.now / 1000, r.clock.now / 1000);
  const at = r.read().at;
  r.advance(10_000);
  s.tick();
  assert.equal(s.holdsLease(), false);
  assert.equal(r.read().at, at, "nothing written while standing by");
  r.advance(31_000);
  s.tick();
  assert.equal(s.holdsLease(), true, "the stale foreign lease is taken");
  assert.notEqual(r.read().at, at);
});

test("lease: taking it resets the CPU base; history and samples come from strip.json, a recent sparkline only", (t) => {
  const r = rig({ config: strip({ quotas: { claude: true } }) });
  t.after(r.done);
  const reset = Math.round((r.clock.now + 3 * 24 * HOUR_MS) / 1000);
  fs.mkdirSync(path.dirname(stripPath(r.agentDir)), { recursive: true });
  const file = (at: number) => JSON.stringify({ version: 1, at: iso(at), sampleSeconds: 10, cpu: { pct: 1, history: [5, 6, 7], tone: "neutral" }, quotas: [{ key: "claude:7d", label: "x", used: 0.3, resetsAt: iso(reset * 1000), tone: "green" }], samples: { "claude:7d": [[Math.round(r.clock.now / 1000) - 1000, 0.3]], junk: "x" } });
  fs.writeFileSync(stripPath(r.agentDir), file(r.clock.now - 60_000));
  const s = r.mk();
  r.snap.value = cpu(100, 100);
  s.tick();
  assert.deepEqual(r.read().cpu?.history, [5, 6, 7], "recent: loaded; the first tick after taking has no CPU value");
  assert.equal(r.read().cpu?.pct, undefined);
  assert.deepEqual(r.read().samples["claude:7d"], [[Math.round(r.clock.now / 1000) - 1000, 0.3]]);
  assert.equal("junk" in r.read().samples, false);
  void s.stop();
  fs.writeFileSync(stripPath(r.agentDir), file(r.clock.now - 130_000)); // older than 12 x 10 s
  const s2 = r.mk();
  s2.tick();
  assert.deepEqual(r.read().cpu?.history, [], "an old sparkline is not loaded");
  assert.equal(r.read().samples["claude:7d"].length, 1, "forecast samples are always loaded");
  void s2.stop();
  fs.writeFileSync(stripPath(r.agentDir), "{broken");
  const s3 = r.mk();
  s3.tick();
  assert.deepEqual(r.read().samples, {});
  void s3.stop();
  fs.writeFileSync(stripPath(r.agentDir), JSON.stringify({ version: 9, cpu: { history: [1] } }));
  const s4 = r.mk();
  s4.tick();
  assert.deepEqual(r.read().cpu?.history, []);
});

test("a failed rename is skipped without throwing and retried next tick", (t) => {
  const r = rig();
  t.after(r.done);
  const s = r.mk();
  fs.mkdirSync(stripPath(r.agentDir), { recursive: true }); // a directory where the file goes: the rename fails
  assert.doesNotThrow(() => s.tick());
  fs.rmSync(stripPath(r.agentDir), { recursive: true });
  r.advance(10_000);
  s.tick();
  assert.equal(r.read().version, 1);
});

const week = (used: number, resetSec: number): Record<string, string> => hdrs("7d", String(used), resetSec);

test("claude hook: writes windows, merges and keeps windows not in the response, throttles, ignores bad input", (t) => {
  const r = rig();
  t.after(r.done);
  const clock = { now: T0 };
  const h = new ClaudeUsageHook(() => clock.now);
  const cfg = {};
  const file = stripClaudePath(r.agentDir);
  const reset = Math.round(T0 / 1000) + 86400;
  assert.equal(h.record(r.agentDir, cfg, {}), "none");
  assert.equal(fs.existsSync(file), false, "no headers, no write");
  assert.equal(h.record(r.agentDir, cfg, { "anthropic-ratelimit-unified-7d-reset": String(reset) }), "none");
  assert.equal(h.record(r.agentDir, cfg, { "anthropic-ratelimit-unified-overage-reset": String(reset), "anthropic-ratelimit-unified-status": "allowed" }), "none");
  assert.equal(h.record(r.agentDir, cfg, { ...hdrs("Up Per", "0.1", reset) }), "none", "a name outside the id rule");
  assert.equal(h.record(r.agentDir, cfg, { ...hdrs("7d", "41", reset) }), "none", "above 2 rejected");
  assert.equal(fs.existsSync(file), false);
  assert.equal(h.record(r.agentDir, cfg, { ...week(0.06, reset), ...hdrs("5h", "0.5", reset - 100) }), "written");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { windows: { "7d": { used: 0.06, resetsAt: reset, at: Math.round(T0 / 1000) }, "5h": { used: 0.5, resetsAt: reset - 100, at: Math.round(T0 / 1000) } } });
  clock.now += 5000;
  assert.equal(h.record(r.agentDir, cfg, week(0.07, reset)), "throttled");
  clock.now += 30_000;
  assert.equal(h.record(r.agentDir, cfg, week(0.07, reset)), "written");
  const got = JSON.parse(fs.readFileSync(file, "utf8")) as { windows: Record<string, { used: number }> };
  assert.equal(got.windows["7d"].used, 0.07);
  assert.equal(got.windows["5h"].used, 0.5, "a window the response lacks is kept");
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith(".tmp") || n.endsWith(".lock")), []);
});

test("claude hook: disabled writes nothing; a held lock skips the write within about 200 ms and the next reply retries", (t) => {
  const r = rig();
  t.after(r.done);
  const h = new ClaudeUsageHook(() => T0);
  const reset = Math.round(T0 / 1000) + 86400;
  for (const c of [strip({ enabled: false }), strip({ quotas: { claude: false } })]) assert.equal(h.record(r.agentDir, c, week(0.1, reset)), "off");
  assert.equal(fs.existsSync(stripClaudePath(r.agentDir)), false);
  const lock = `${stripClaudePath(r.agentDir)}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, "someone-else");
  const t0 = Date.now();
  assert.equal(h.record(r.agentDir, {}, week(0.1, reset)), "locked");
  const took = Date.now() - t0;
  assert.ok(took >= 150 && took < 1500, `waited ${took} ms`);
  assert.equal(fs.existsSync(stripClaudePath(r.agentDir)), false);
  fs.unlinkSync(lock);
  assert.equal(h.record(r.agentDir, {}, week(0.1, reset)), "written", "a skipped write does not use the throttle");
  assert.equal(withFileLock(lock, () => 1), 1);
});

test("claude rows reach strip.json: hidden until a value arrives, week pace and tone, dash after the reset, hide and order", (t) => {
  const r = rig();
  t.after(r.done);
  const s = r.mk();
  s.tick();
  assert.equal("quotas" in r.read(), false, "no window yet: no row");
  const reset = Math.round((r.clock.now + 3.5 * 24 * HOUR_MS) / 1000);
  const hook = new ClaudeUsageHook(() => r.clock.now);
  hook.record(r.agentDir, {}, { ...week(0.41, reset), ...hdrs("5h", "0.95", Math.round((r.clock.now + HOUR_MS) / 1000)) });
  r.advance(10_000);
  s.tick();
  const q = r.read().quotas!;
  assert.deepEqual(q.map((x) => x.key), ["claude:5h", "claude:7d"]);
  assert.equal(q[1].label, "Claude week");
  assert.equal(q[1].used, 0.41);
  assert.equal(q[1].pace, 0.5, "half the week has passed");
  assert.equal(q[1].tone, "green");
  assert.equal(q[0].tone, "amber", "0.95 used with 80 % of the 5 hours passed is ahead of pace");
  assert.equal(q[1].resetsAt, iso(reset * 1000));
  r.cfg.value = strip({ quotas: { hide: ["claude:5h"] } });
  r.advance(10_000);
  s.tick();
  assert.deepEqual(r.read().quotas?.map((x) => x.key), ["claude:7d"]);
  r.cfg.value = strip({ quotas: { order: ["claude:7d", "claude:5h"] } });
  r.advance(10_000);
  s.tick();
  assert.deepEqual(r.read().quotas?.map((x) => x.key), ["claude:7d", "claude:5h"]);
  r.advance(4 * 24 * HOUR_MS);
  s.tick();
  assert.deepEqual(r.read().quotas?.map((x) => [x.key, x.used]), [["claude:7d", null], ["claude:5h", null]], "a passed reset shows a dash, not nothing");
});

test("forecast samples: spaced by period/200, a changed reset clears them, a steep week turns red, an unseen row is dropped after 7 days", (t) => {
  const r = rig();
  t.after(r.done);
  const s = r.mk();
  const hook = new ClaudeUsageHook(() => 0);
  let reset = Math.round((r.clock.now + 6 * 24 * HOUR_MS) / 1000);
  const put = (used: number, rs = reset): void => {
    fs.mkdirSync(path.dirname(stripClaudePath(r.agentDir)), { recursive: true });
    fs.writeFileSync(stripClaudePath(r.agentDir), JSON.stringify({ windows: { "7d": { used, resetsAt: rs, at: 1 } } }));
  };
  void hook;
  put(0.1);
  s.tick();
  r.advance(10_000);
  s.tick();
  assert.equal(r.read().samples["claude:7d"].length, 1, "10 s is under the 50 minute spacing");
  // a steep climb over the last seventh of the week (24 h): 0.1 per 4 h
  for (let i = 1; i <= 6; i++) {
    r.advance(4 * HOUR_MS);
    put(0.1 + i * 0.1);
    s.tick();
  }
  assert.ok(r.read().samples["claude:7d"].length >= 6);
  assert.equal(r.read().quotas?.[0].tone, "red", "0.7 used, rising 0.1 per 4 h, runs out before the reset");
  reset += 7 * 24 * 3600;
  put(0.05, reset);
  r.advance(10_000);
  s.tick();
  assert.deepEqual(r.read().samples["claude:7d"].map((x) => x[1]), [0.05], "a new period starts a new history");
  assert.notEqual(r.read().quotas?.[0].tone, "red");
  fs.rmSync(stripClaudePath(r.agentDir));
  r.advance(6 * 24 * HOUR_MS);
  s.tick();
  assert.ok("claude:7d" in r.read().samples, "unseen for under 7 days");
  r.advance(2 * 24 * HOUR_MS);
  s.tick();
  assert.equal("claude:7d" in r.read().samples, false, "unseen for over 7 days");
});

const rows = (...ids: string[]): string => JSON.stringify(ids.map((id) => ({ id, label: id.toUpperCase(), used: 0.2 })));

test("source: good rows run through the extstatus rules and show; the run gets program, args, cwd and the session id", { skip: win }, async (t) => {
  const r = rig({ config: strip({ quotas: { claude: false, sources: { team: { command: "usagecmd --json 'two words'" } } } }) });
  t.after(r.done);
  r.reply.fn = () => ({ stdout: JSON.stringify([{ id: "credits-month", label: "Team credits", used: 0.41, resetsAt: iso(r.clock.now + 10 * 24 * HOUR_MS), period: "month" }]) });
  const s = r.mk();
  s.tick();
  await s.drain();
  assert.equal(r.runs[0].program, fs.realpathSync.native(r.tool));
  assert.deepEqual(r.runs[0].args, ["--json", "two words"]);
  assert.deepEqual(r.read().quotas?.map((x) => [x.key, x.label, x.used]), [["team:*", "team", null]], "the first tick shows the placeholder");
  r.advance(10_000);
  s.tick();
  const q = r.read().quotas![0];
  assert.deepEqual([q.key, q.label, q.used], ["team:credits-month", "Team credits", 0.41]);
  assert.equal(r.runs.length, 1, "the script runs on its own interval, not every tick");
});

test("source: bad JSON keeps the last good rows one interval, then dashes; recovery shows rows again", { skip: win }, async (t) => {
  const r = rig({ config: strip({ quotas: { claude: false, sources: { team: { command: "usagecmd", seconds: 60 } } } }) });
  t.after(r.done);
  r.reply.fn = () => ({ stdout: rows("a") });
  const s = r.mk();
  // one run, then a second tick (inside the interval, so no new run) that shows its result
  const round = async (): Promise<void> => {
    s.tick();
    await s.drain();
    r.advance(1000);
    s.tick();
    r.advance(60_000);
  };
  await round();
  assert.equal(r.read().quotas?.[0].used, 0.2);
  r.reply.fn = () => ({ stdout: "not json" });
  await round();
  assert.equal(r.read().quotas?.[0].used, 0.2, "one bad run: the last good rows stay");
  await round();
  assert.deepEqual(r.read().quotas?.map((x) => [x.key, x.used]), [["team:a", null]], "two bad runs: a dash");
  r.reply.fn = () => ({ stdout: rows("a", "b") });
  await round();
  assert.deepEqual(r.read().quotas?.map((x) => x.used), [0.2, 0.2]);
});

test("source: never valid gives a placeholder row; timeout, exit code and a missing program are failures; over 8 rows cut; bad id dropped; overrun red; used 41 dash", { skip: win }, async (t) => {
  const r = rig({ config: strip({ quotas: { claude: false, sources: { broken: { command: "usagecmd" }, gone: { command: "no-such-program-here" }, big: { command: "usagecmd --big" } } } }) });
  t.after(r.done);
  r.reply.fn = () => ({ stdout: "", timedOut: true, code: null });
  const s = r.mk();
  s.tick();
  await s.drain();
  s.tick();
  assert.deepEqual(r.read().quotas?.map((x) => [x.key, x.label, x.used]), [["broken:*", "broken", null], ["gone:*", "gone", null], ["big:*", "big", null]]);
  assert.ok(r.traces.some((x) => x.event === "strip_source" && x.source === "broken" && x.outcome === "timeout"));
  assert.ok(r.traces.some((x) => x.source === "gone" && x.outcome === "program_missing"));
  r.reply.fn = () => ({ stdout: JSON.stringify([...Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, label: `R${i}`, used: 0.1 })), { id: "BAD", used: 0.1 }]) });
  r.advance(301_000);
  s.tick();
  await s.drain();
  s.tick();
  assert.equal(r.read().quotas?.filter((x) => x.key.startsWith("big:") || x.key.startsWith("broken:")).length, 16);
  r.reply.fn = (p) => ({ stdout: JSON.stringify([{ id: "over", label: "Over", used: 1.3 }, { id: "unit", label: "Unit", used: 41 }]), code: p ? 0 : 1 });
  r.advance(301_000);
  s.tick();
  await s.drain();
  s.tick();
  const over = r.read().quotas?.filter((x) => x.key === "broken:over" || x.key === "big:over");
  assert.equal(over?.length, 2);
  assert.deepEqual([over![0].used, over![0].tone], [1.3, "red"]);
  assert.equal(r.read().quotas?.find((x) => x.key === "broken:unit")?.used, null);
});

test("source: exit code != 0 and a thrown spawn count as failures; a stop discards a late result", { skip: win }, async (t) => {
  const r = rig({ config: strip({ quotas: { claude: false, sources: { team: { command: "usagecmd" } } } }) });
  t.after(r.done);
  r.reply.fn = () => ({ code: 3, stdout: rows("a") });
  const s = r.mk();
  s.tick();
  await s.drain();
  s.tick();
  assert.equal(r.read().quotas?.[0].key, "team:*");
  const r2 = rig({ config: strip({ quotas: { claude: false, sources: { team: { command: "usagecmd" } } } }) });
  t.after(r2.done);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((res) => (release = res));
  const s2 = r2.mk({ spawner: async () => (await gate, { code: 0, stdout: rows("a"), stderr: "", overflow: false, timedOut: false }) });
  s2.tick();
  void s2.stop();
  release();
  await s2.drain();
  assert.equal(r2.exists() ? r2.read().quotas?.some((x) => x.key === "team:a") : false, false);
});

test("source: a command under the workspace is refused", { skip: win }, async (t) => {
  const r = rig({ config: strip({ quotas: { claude: false, sources: { team: { command: "usagecmd" } } } }) });
  t.after(r.done);
  const inside = path.join(r.ws, "usagecmd");
  fs.copyFileSync(r.tool, inside);
  fs.chmodSync(inside, 0o755);
  const s = r.mk({ env: { PATH: r.ws } });
  s.tick();
  await s.drain();
  assert.deepEqual(r.runs, []);
  assert.ok(r.traces.some((x) => x.outcome === "program_missing"));
});

// ---- the adapter: foreman session samples, child does not, every session notes Claude headers ----

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
let rigs = 0;

async function adapter(t: { after(fn: () => void | Promise<void>): void }, o: { child?: boolean; config?: unknown } = {}) {
  const keys = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_FOREMAN_PRESSURE_FIXTURE"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const savedExit = process.exitCode;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-strip-adapter-")));
  let shutdown: (() => Promise<unknown>) | undefined;
  t.after(async () => {
    try { await shutdown?.(); } catch { /* best effort */ }
    await waitQuiet(path.join(root, "agent", "pi-foreman", "state"));
    rmTestTmp(root);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    process.exitCode = savedExit;
  });
  const project = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  if (o.child) process.env.PI_SUBAGENT_CHILD = "1";
  else delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_FOREMAN_PRESSURE_FIXTURE;
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify(o.config ?? {}));
  const handlers = new Map<string, Handler>();
  const pi = {
    events: { on: () => undefined, emit: () => undefined },
    on: (n: string, h: Handler) => {
      const prev = handlers.get(n);
      handlers.set(n, !prev ? h : async (e, c) => { const a = await prev(e, c); const b = await h(e, c); return a ?? b; });
    },
    registerCommand: () => undefined,
    registerTool: () => undefined,
    getActiveTools: () => [] as string[],
    getAllTools: () => [{ name: "bash" }],
    setActiveTools: () => undefined,
    setModel: async () => true,
    setThinkingLevel: () => undefined,
    sendMessage: () => undefined,
  };
  coreAdapter(pi as never, { pressureNow: () => Date.now(), pressureRun: async () => ({ ok: true, text: "" }), spawner: probeSpawner() });
  const sessionId = `strip-adapter-${++rigs}`;
  const ctx = {
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
    cwd: project,
    model: { provider: "fake", id: "m" },
    mode: o.child ? "json" : "tui",
    hasUI: !o.child,
    abort: () => undefined,
    isProjectTrusted: () => false,
    isIdle: () => true,
    modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
    ui: { notify: () => undefined, confirm: async () => false, select: async () => undefined, setStatus: () => undefined, setWidget: () => undefined },
  };
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  shutdown = async () => handlers.get("session_shutdown")?.({}, ctx);
  return { agentDir, handlers, ctx, shutdown: () => shutdown!() };
}

const until = async (ok: () => boolean, ms = 3000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return ok();
};

test("adapter: the foreman session samples and gives the lease back at shutdown", async (t) => {
  const a = await adapter(t);
  assert.equal(await until(() => fs.existsSync(stripPath(a.agentDir))), true);
  assert.equal(fs.existsSync(stripLeasePath(a.agentDir)), true);
  assert.equal((JSON.parse(fs.readFileSync(stripPath(a.agentDir), "utf8")) as StripDoc).version, 1);
  await a.shutdown();
  assert.equal(fs.existsSync(stripLeasePath(a.agentDir)), false);
});

test("adapter: enabled false starts no sampler", async (t) => {
  const a = await adapter(t, { config: strip({ enabled: false }) });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fs.existsSync(stripPath(a.agentDir)), false);
  assert.equal(fs.existsSync(stripLeasePath(a.agentDir)), false);
});

test("adapter: a child session starts no sampler and runs no scripts, but notes Claude headers", async (t) => {
  const a = await adapter(t, { child: true, config: strip({ quotas: { sources: { team: { command: "usagecmd" } } } }) });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fs.existsSync(stripPath(a.agentDir)), false);
  assert.equal(fs.existsSync(stripLeasePath(a.agentDir)), false);
  const reset = Math.round(Date.now() / 1000) + 3600;
  await a.handlers.get("after_provider_response")!({ status: 200, headers: hdrs("7d", "0.2", reset) }, a.ctx);
  const got = JSON.parse(fs.readFileSync(stripClaudePath(a.agentDir), "utf8")) as { windows: Record<string, { used: number }> };
  assert.equal(got.windows["7d"].used, 0.2);
});

test("adapter: with the strip off a reply writes no Claude note", async (t) => {
  const a = await adapter(t, { config: strip({ enabled: false }) });
  await a.handlers.get("after_provider_response")!({ status: 200, headers: hdrs("7d", "0.2", Math.round(Date.now() / 1000) + 3600) }, a.ctx);
  assert.equal(fs.existsSync(stripClaudePath(a.agentDir)), false);
});
