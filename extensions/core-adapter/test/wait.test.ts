import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, readBaseline } from "../permoverlay.ts";
import { causeOfCustom } from "../usage.ts";
import { checkRunId, checkWaitPath, Governor, parseStart, resolveGh, WaitRuntime, wakeMessage } from "../wait.ts";
import type { Outcome, Timers, WaitLimits } from "../wait.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-wait-")));
const ws = path.join(root, "ws");
const agentDir = path.join(root, "agent");
const outside = path.join(root, "outside");
for (const d of [ws, path.join(ws, ".workflow"), path.join(ws, ".git"), path.join(agentDir, "pi-foreman", "state", "wait"), outside]) fs.mkdirSync(d, { recursive: true });
execFileSync("git", ["init", "-q", ws]);
fs.symlinkSync(outside, path.join(ws, "out-link"), "dir");
const overlay = buildOverlayRules(readBaseline(PKG)!, {}, {}, agentDir);
const bound = { cwd: ws, home: root, agentDir, platform: process.platform, overlay };
const LIMITS: WaitLimits = { batchWindowSeconds: 300, maxSeconds: 86400, maxActive: 2, ci: true };

test("wait: file path bound (workspace, .workflow, state/wait allowed; escapes and protected refused)", () => {
  for (const p of ["build/done.flag", ".workflow/ready", path.join(agentDir, "pi-foreman", "state", "wait", "x")]) {
    assert.ok("path" in checkWaitPath(p, bound), p);
  }
  for (const p of [path.join(outside, "x"), "../outside/x", "out-link/x", ".git/HEAD", path.join(agentDir, "pi-foreman", "state", "marker.json")]) {
    const r = checkWaitPath(p, bound);
    assert.ok("error" in r && r.error.includes("refused"), p);
  }
  assert.match((checkWaitPath(".git/HEAD", bound) as { error: string }).error, /write protection/);
  assert.match((checkWaitPath("a.txt", { ...bound, overlay: null }) as { error: string }).error, /baseline is unreadable/);
});

test("wait: runId validation and kind arguments", () => {
  assert.deepEqual(checkRunId("12345678901"), { runId: "12345678901" });
  for (const bad of ["", "12a", "1; rm", "-1", "123456789012345678901", "1\n2", null]) assert.ok("error" in checkRunId(bad), String(bad));
  assert.ok("error" in parseStart({ kind: "ci", runId: "1" }, { ...LIMITS, ci: false }, bound));
  assert.ok("error" in parseStart({ kind: "timer", seconds: 86401 }, LIMITS, bound));
  assert.ok("error" in parseStart({ kind: "pid", pid: 1 }, LIMITS, bound));
  assert.deepEqual(parseStart({ kind: "timer", seconds: 5, note: "a\nb" }, LIMITS, bound), { kind: "timer", seconds: 5, note: "a b" });
});

/** Fake clock: one-shot timers fired by advance(). */
function fakeClock() {
  let now = 0;
  let next = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    set(fn, ms) {
      due.set(++next, { at: now + ms, fn });
      return next;
    },
    clear(h) {
      due.delete(h as number);
    },
  };
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const [id, t] = [...due.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0] ?? [];
      if (id === undefined) break;
      due.delete(id);
      now = t!.at;
      t!.fn();
    }
    now = end;
  };
  return { timers, advance, now: () => now, pending: () => due.size };
}

function runtime(limits: WaitLimits, files: Set<string> = new Set()) {
  const clock = fakeClock();
  const wakes: Outcome[][] = [];
  const trace: Record<string, unknown>[] = [];
  const rt = new WaitRuntime({ timers: clock.timers, now: clock.now, limits: () => limits, stat: (p) => (files.has(p) ? 7 : null), alive: () => true, gh: () => Promise.reject(new Error("unused")), wake: (o) => wakes.push(o), trace: (r) => trace.push(r) });
  return { rt, clock, wakes, trace };
}

test("wait: maxActive refuses one wait too many", () => {
  const { rt, trace } = runtime(LIMITS);
  assert.ok("id" in rt.start({ kind: "timer", seconds: 10, note: "" }));
  assert.ok("id" in rt.start({ kind: "pid", pid: 4242, note: "" }));
  const r = rt.start({ kind: "timer", seconds: 10, note: "" });
  assert.ok("error" in r && r.error.includes("wait.maxActive 2"));
  assert.deepEqual(trace.map((t) => t.decision), ["start", "start", "refused"]);
  rt.dispose();
});

test("wait: governor batches two triggers in the window into one wake with both kinds", () => {
  const files = new Set<string>();
  const { rt, clock, wakes, trace } = runtime({ ...LIMITS, maxActive: 8, batchWindowSeconds: 60 }, files);
  rt.start({ kind: "timer", seconds: 10, note: "t" });
  rt.start({ kind: "file", path: "/f", note: "f" });
  rt.start({ kind: "timer", seconds: 3600, note: "late" });
  clock.advance(10_000);
  assert.equal(wakes.length, 0, "the window is open");
  files.add("/f");
  clock.advance(5_000);
  assert.equal(wakes.length, 0);
  clock.advance(54_000);
  assert.equal(wakes.length, 0, "window opened at 10 s, closes at 70 s");
  clock.advance(1_000);
  assert.equal(wakes.length, 1);
  assert.deepEqual(wakes[0].map((o) => [o.kind, o.outcome]), [["timer", "elapsed"], ["file", "exists, 7 bytes"]]);
  const m = wakeMessage(wakes[0]);
  assert.equal(m.customType, "foreman_wake");
  assert.deepEqual(m.details, { kinds: ["timer", "file"], ids: ["w1", "w2"] });
  assert.equal(m.content.split("\n").length, 2);
  assert.deepEqual(trace.filter((t) => t.decision === "wake").map((t) => t.wakeKinds), ["timer,file"]);
  assert.equal(rt.active, 1);
  rt.dispose();
  assert.equal(clock.pending(), 0, "dispose clears every timer");
});

test("wait: zero window wakes at once; the window closes early when no wait remains", () => {
  const a = runtime({ ...LIMITS, batchWindowSeconds: 0 });
  a.rt.start({ kind: "timer", seconds: 1, note: "" });
  a.rt.start({ kind: "timer", seconds: 100, note: "" });
  a.clock.advance(1000);
  assert.equal(a.wakes.length, 1);
  a.rt.dispose();

  const b = runtime({ ...LIMITS, batchWindowSeconds: 300 });
  b.rt.start({ kind: "timer", seconds: 1, note: "" });
  b.rt.start({ kind: "timer", seconds: 20, note: "" });
  b.clock.advance(1000);
  assert.equal(b.wakes.length, 0);
  b.clock.advance(19_000);
  assert.equal(b.wakes.length, 1, "last wait resolved: no need to wait out the window");
  assert.equal(b.wakes[0].length, 2);
  b.rt.start({ kind: "timer", seconds: 1, note: "" });
  b.clock.advance(1000);
  assert.equal(b.wakes.length, 2, "a later trigger opens a new window");

  const c = runtime({ ...LIMITS, batchWindowSeconds: 300 });
  c.rt.start({ kind: "timer", seconds: 1, note: "" });
  c.rt.start({ kind: "timer", seconds: 100, note: "" });
  c.clock.advance(1000);
  assert.ok(c.rt.cancel("w2"));
  assert.equal(c.wakes.length, 1, "a cancel that leaves no wait closes the window");
  const g = new Governor({ windowMs: () => 0, active: () => 0, timers: c.clock.timers, send: () => assert.fail("nothing pending") });
  g.check();
});

test("wait: every wait times out at wait.maxSeconds", () => {
  const { rt, clock, wakes } = runtime({ ...LIMITS, maxSeconds: 30, batchWindowSeconds: 0 });
  rt.start({ kind: "pid", pid: 4242, note: "" });
  clock.advance(30_000);
  assert.deepEqual(wakes[0].map((o) => o.outcome), ["timeout"]);
});

test("wait: causeOfCustom maps foreman_wake to the wake cause", () => {
  assert.equal(causeOfCustom("foreman_wake"), "wake");
});

test("wait: a file poll keeps a bounded number of timer handles", () => {
  const { rt, clock } = runtime(LIMITS);
  rt.start({ kind: "file", path: "/never", note: "" });
  clock.advance(2000 * 500);
  assert.ok(clock.pending() <= 2, `pending timers: ${clock.pending()}`);
  rt.dispose();
  assert.equal(clock.pending(), 0);
});

test("wait: ci start is refused when ghRefusal reports no gh", () => {
  const clock = fakeClock();
  const rt = new WaitRuntime({ timers: clock.timers, now: clock.now, limits: () => LIMITS, stat: () => null, alive: () => true, gh: () => Promise.reject(new Error("unused")), ghRefusal: () => "gh missing", wake: () => {}, trace: () => {} });
  const r = rt.start({ kind: "ci", runId: "1", note: "" });
  assert.ok("error" in r && r.error.includes("gh missing"));
  assert.equal(rt.active, 0);
});

test("resolveGh: skips empty, relative and workspace PATH entries, so a planted gh is not picked", { skip: process.platform === "win32" }, () => {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const d of [ws, bin]) {
    fs.writeFileSync(path.join(d, "gh"), "#!/bin/sh\n");
    fs.chmodSync(path.join(d, "gh"), 0o755);
  }
  const env = (p: string): NodeJS.ProcessEnv => ({ PATH: p });
  assert.equal(resolveGh(ws, env([ "", ".", "bin", ws, bin].join(":")), "linux"), path.join(bin, "gh"));
  assert.equal(resolveGh(ws, env(["", ".", "bin", ws, path.join(ws, "sub")].join(":")), "linux"), null);
  assert.equal(resolveGh(ws, env(""), "linux"), null);
  fs.unlinkSync(path.join(bin, "gh"));
  assert.equal(resolveGh(ws, env([ws, bin].join(":")), "linux"), null);
});
