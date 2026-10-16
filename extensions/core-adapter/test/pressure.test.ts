// Host pressure (pressure.ts): the file reader mirrors the Python read_state, the sampler timer, the wait kind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { criticalReason, limitsOf, narrowTasks, PressureSampler, pressureOutcome, pressurePath, queuedReason, readPressure, sampleSecondsOf } from "../pressure.ts";
import { parseStart, TOOL_WAIT_KINDS, WAIT_KINDS, WaitRuntime } from "../wait.ts";
import type { Outcome, Timers, WaitLimits } from "../wait.ts";

function tmp(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-press-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const NOW = Date.parse("2026-01-01T12:00:00Z");
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const put = (file: string, rec: unknown): void => fs.writeFileSync(file, typeof rec === "string" ? rec : JSON.stringify(rec));

test("pressurePath is <agentDir>/pi-foreman/state/pressure.json", () => {
  assert.equal(pressurePath("/a"), path.join("/a", "pi-foreman", "state", "pressure.json"));
});

test("readPressure: ok, high and critical records are returned as written", (t) => {
  const file = path.join(tmp(t), "pressure.json");
  for (const [level, reasons] of [["ok", []], ["high", ["load"]], ["critical", ["mem", "disk"]]] as const) {
    put(file, { level, reasons, at: iso(NOW - 5000), host: { loadPerCore: 2 } });
    assert.deepEqual(readPressure(file, 30, NOW), { level, reasons, at: iso(NOW - 5000), host: { loadPerCore: 2 } });
  }
});

test("readPressure: older than 3x sampleSeconds is ok/stale, exactly 3x is still current", (t) => {
  const file = path.join(tmp(t), "pressure.json");
  put(file, { level: "critical", reasons: ["mem"], at: iso(NOW - 90_000), host: {} });
  assert.equal(readPressure(file, 30, NOW).level, "critical");
  put(file, { level: "critical", reasons: ["mem"], at: iso(NOW - 91_000), host: {} });
  const r = readPressure(file, 30, NOW);
  assert.equal(r.level, "ok");
  assert.deepEqual(r.reasons, ["stale"]);
  put(file, { level: "high", reasons: ["load"], at: iso(NOW - 30_000), host: {} });
  assert.equal(readPressure(file, 5, NOW).level, "ok", "5 s sampling makes 30 s old stale");
});

test("readPressure: missing and garbage files are ok/missing", (t) => {
  const dir = tmp(t);
  const file = path.join(dir, "pressure.json");
  assert.deepEqual(readPressure(file, 30, NOW).reasons, ["missing"]);
  for (const bad of ["not json", "[]", "null", "{}", JSON.stringify({ level: "bogus", at: iso(NOW) }), JSON.stringify({ level: "high" }), JSON.stringify({ level: "high", at: "yesterday" }), JSON.stringify({ level: "high", at: 5 })]) {
    put(file, bad);
    const r = readPressure(file, 30, NOW);
    assert.equal(r.level, "ok", bad);
    assert.deepEqual(r.reasons, ["missing"], bad);
  }
});

test("readPressure agrees with the Python read_state on the same files", (t) => {
  const dir = tmp(t);
  const file = path.join(dir, "pressure.json");
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "foreman_pressure.py");
  const py = (args: string[]) => {
    const r = spawnSync("python3", ["-I", script, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return r.status === 0 ? (JSON.parse(r.stdout) as { level: string; reasons: string[] }) : null;
  };
  const wall = Date.now();
  for (const rec of [{ level: "high", reasons: ["load"], at: iso(wall), host: {} }, { level: "critical", reasons: ["mem"], at: iso(wall - 200_000), host: {} }]) {
    put(file, rec);
    const theirs = py(["read", "--state", file, "--sample-seconds", "30"]);
    if (!theirs) return t.skip("python3 not available");
    const ours = readPressure(file, 30, wall + 1000);
    assert.deepEqual({ level: ours.level, reasons: ours.reasons }, { level: theirs.level, reasons: theirs.reasons });
  }
});

test("config helpers: sampleSeconds (default 30, minimum 5) and the numeric limits", () => {
  assert.equal(sampleSecondsOf({}), 30);
  assert.equal(sampleSecondsOf({ resources: { sampleSeconds: 12 } }), 12);
  assert.equal(sampleSecondsOf({ resources: { sampleSeconds: 2 } }), 30);
  assert.equal(sampleSecondsOf({ resources: { sampleSeconds: "9" } }), 30);
  assert.deepEqual(limitsOf({ resources: { maxLoadPerCore: 1.5, minFreeMemMB: 1024, minFreeDiskGB: 5, sampleSeconds: 30, junk: 1 } }), { maxLoadPerCore: 1.5, minFreeMemMB: 1024, minFreeDiskGB: 5 });
  assert.deepEqual(limitsOf({}), {});
});

test("sampler: ticks at start and every interval through the injected runner; never overlaps; one trace on failure", async () => {
  const calls: string[][] = [];
  const traces: Record<string, unknown>[] = [];
  let release: () => void = () => undefined;
  let ticker: () => void = () => undefined;
  let interval = 0;
  let fail = false;
  const s = new PressureSampler({
    file: "/state/pressure.json",
    workspace: "/ws",
    config: () => ({ resources: { sampleSeconds: 7, minFreeMemMB: 100 } }),
    fixture: "/fx.json",
    run: (args) => {
      calls.push(args);
      if (fail) return Promise.reject(new Error("boom"));
      return new Promise((r) => (release = () => r({ ok: true, text: "" })));
    },
    trace: (r) => traces.push(r),
    setInterval: (fn, ms) => ((ticker = fn), (interval = ms), 1),
    clearInterval: () => undefined,
  });
  s.start();
  s.start();
  assert.equal(interval, 7000);
  assert.deepEqual(calls[0], ["sample", "--workspace", "/ws", "--state", "/state/pressure.json", "--limits", '{"minFreeMemMB":100}', "--fixture", "/fx.json"]);
  ticker();
  assert.equal(calls.length, 1, "a tick while one is in flight is skipped");
  release();
  await new Promise((r) => setImmediate(r));
  ticker();
  assert.equal(calls.length, 2);
  release();
  await new Promise((r) => setImmediate(r));
  fail = true;
  ticker();
  await new Promise((r) => setImmediate(r));
  ticker();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(traces, [{ event: "pressure_sampler", reason: "sampler_error" }], "traced once");
  s.stop();
});

test("narrowTasks keeps the first task and returns the call with the rest", () => {
  const input = { tasks: [{ agent: "a", task: "1" }, { agent: "b", task: "2" }, { agent: "c", task: "3" }], model: "m" };
  const rest = narrowTasks(input);
  assert.deepEqual(input.tasks, [{ agent: "a", task: "1" }]);
  assert.deepEqual(rest, { tasks: [{ agent: "b", task: "2" }, { agent: "c", task: "3" }], model: "m" });
  assert.equal(narrowTasks({ tasks: [{ agent: "a" }] }), null);
  assert.equal(narrowTasks({ agent: "a", task: "x" }), null);
  assert.equal(narrowTasks({ chain: [{ agent: "a" }, { agent: "b" }] }), null);
});

test("texts: critical refusal, queued, outcomes", () => {
  assert.equal(criticalReason(["mem", "disk"]), "pressure critical (mem, disk): launch deferred; you will be woken when it drops");
  assert.match(queuedReason(["load"]), /^pressure high \(load\): child launches run one at a time/);
  assert.equal(pressureOutcome("critical", "high", [{ agent: "b" }]), 'pressure: high, relaunch with: {"agent":"b"}');
  assert.equal(pressureOutcome("critical", "timeout", [{ agent: "b" }]), 'pressure: still critical, relaunch with: {"agent":"b"}');
  assert.match(pressureOutcome("queue", "ok", [{ a: 1 }, { a: 2 }]), /relaunch the queued launches one at a time with: \[\{"a":1\},\{"a":2\}\]$/);
});

// -- the `pressure` wait kind ---------------------------------------------------------------------

const LIMITS: WaitLimits = { batchWindowSeconds: 0, maxSeconds: 86400, maxActive: 4, ci: true };

function fakeClock() {
  let now = 0;
  const pending: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  const timers: Timers = {
    set: (fn, ms) => (pending.push({ at: now + ms, fn, id: ++seq }), seq),
    clear: (h) => void pending.splice(0, pending.length, ...pending.filter((p) => p.id !== h)),
  };
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      pending.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = pending[0];
      if (!next || next.at > end) break;
      pending.shift();
      now = next.at;
      next.fn();
    }
    now = end;
  };
  return { timers, advance, now: () => now };
}

function runtime(level: () => string, idle: () => boolean = () => true) {
  const clock = fakeClock();
  const wakes: Outcome[][] = [];
  const rt = new WaitRuntime({ timers: clock.timers, now: clock.now, limits: () => LIMITS, stat: () => null, alive: () => true, gh: () => Promise.reject(new Error("unused")), wake: (o) => wakes.push(o), trace: () => undefined, pressure: () => ({ level: level(), reasons: [] }), idle });
  return { rt, wakes, clock };
}

test("pressure is a wait kind but not one foreman_wait start accepts", () => {
  assert.ok((WAIT_KINDS as readonly string[]).includes("pressure"));
  assert.ok(!(TOOL_WAIT_KINDS as readonly string[]).includes("pressure"));
  const r = parseStart({ kind: "pressure" }, LIMITS, { cwd: "/ws", home: "/h", agentDir: "/a", platform: process.platform, overlay: null });
  assert.ok("error" in r);
});

test("critical wait: re-checks every interval, wakes with the args when the level drops below critical", () => {
  let level = "critical";
  const { rt, wakes, clock } = runtime(() => level);
  const args = { agent: "builder", task: "do it" };
  assert.ok("id" in rt.start({ kind: "pressure", mode: "critical", args: [args], pollMs: 30_000, boundSeconds: 600, note: "launch deferred" }));
  clock.advance(90_000);
  assert.equal(wakes.length, 0);
  assert.equal(rt.active, 1);
  level = "high";
  clock.advance(29_000);
  assert.equal(wakes.length, 0, "not before the next check");
  clock.advance(1_000);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0][0].kind, "pressure");
  assert.equal(wakes[0][0].outcome, `pressure: high, relaunch with: ${JSON.stringify(args)}`);
  assert.equal(rt.active, 0);
});

test("critical wait: after 600 s it wakes with 'still critical' and the args", () => {
  const { rt, wakes, clock } = runtime(() => "critical");
  const args = { agent: "builder", task: "t" };
  rt.start({ kind: "pressure", mode: "critical", args: [args], pollMs: 30_000, boundSeconds: 600, note: "" });
  clock.advance(599_000);
  assert.equal(wakes.length, 0);
  clock.advance(1_000);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0][0].outcome, `pressure: still critical, relaunch with: ${JSON.stringify(args)}`);
  assert.equal(rt.active, 0);
  clock.advance(1_000_000);
  assert.equal(wakes.length, 1, "no further wake");
});

test("queue wait: wakes with every queued launch once no run is active, or when the level is ok; a cancel stops the polling", () => {
  let idle = false;
  let level = "high";
  const { rt, wakes, clock } = runtime(() => level, () => idle);
  const q: unknown[] = [{ agent: "a" }];
  const r = rt.start({ kind: "pressure", mode: "queue", args: q, pollMs: 10_000, boundSeconds: Infinity, note: "queued launches" });
  assert.ok("id" in r);
  q.push({ agent: "b" });
  clock.advance(50_000);
  assert.equal(wakes.length, 0);
  idle = true;
  clock.advance(10_000);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0][0].outcome, `pressure: high, a run ended; relaunch the queued launches one at a time with: ${JSON.stringify(q)}`);

  idle = false;
  const second = runtime(() => level, () => idle);
  second.rt.start({ kind: "pressure", mode: "queue", args: [{ agent: "c" }], pollMs: 10_000, boundSeconds: Infinity, note: "" });
  level = "ok";
  second.clock.advance(10_000);
  assert.equal(second.wakes.length, 1, "level ok ends the queue wait");

  const third = runtime(() => "high", () => false);
  const s3 = third.rt.start({ kind: "pressure", mode: "queue", args: [{ agent: "d" }], pollMs: 10_000, boundSeconds: Infinity, note: "" });
  assert.ok("id" in s3 && third.rt.cancel(s3.id));
  third.clock.advance(100_000);
  assert.equal(third.wakes.length, 0);
});
