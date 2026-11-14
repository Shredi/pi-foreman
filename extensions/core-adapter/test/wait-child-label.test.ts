// One child wait per label, and a carried notice taken inside a run (wait.ts WaitRuntime): the dedupe on start, the named wait over `any`, the
// quiet end through `taken`, and the pending outcome of another wait flushed when the taken notice ended the last active wait.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WaitRuntime } from "../wait.ts";
import type { Outcome, Timers, WaitLimits } from "../wait.ts";

const LIMITS: WaitLimits = { batchWindowSeconds: 300, maxSeconds: 86400, maxActive: 4, ci: true };

function runtime(inRun = false) {
  const wakes: Outcome[][] = [];
  const taken: Outcome[] = [];
  const traces: Record<string, unknown>[] = [];
  const fns = new Map<number, { fn: () => void; ms: number }>();
  let n = 0;
  const timers: Timers = { set: (fn, ms) => (fns.set(++n, { fn, ms }), n), clear: (h) => void fns.delete(h as number) };
  const state = { inRun };
  const rt = new WaitRuntime({ timers, now: () => 0, limits: () => LIMITS, stat: () => null, alive: () => true, gh: () => Promise.reject(new Error("unused")), wake: (o) => wakes.push(o), trace: (r) => traces.push(r), inRun: () => state.inRun, taken: (o) => taken.push(o) });
  return { rt, wakes, taken, traces, fns, state };
}

test("child wait: a second start on a label returns the first id, deduped, and starts nothing", () => {
  const { rt, traces } = runtime();
  const first = rt.start({ kind: "child", label: "job", note: "first" });
  assert.deepEqual(first, { id: "w1" });
  assert.deepEqual(rt.start({ kind: "child", label: "job", note: "second" }), { id: "w1", deduped: true });
  assert.equal(rt.active, 1);
  assert.equal(rt.list()[0].note, "first", "the second note is dropped");
  assert.equal(traces.filter((t) => t.decision === "start").length, 1);
});

test("child wait: the label any is deduped too; another label is its own wait", () => {
  const { rt } = runtime();
  assert.deepEqual(rt.start({ kind: "child", label: "any", note: "" }), { id: "w1" });
  assert.deepEqual(rt.start({ kind: "child", label: "any", note: "x" }), { id: "w1", deduped: true });
  assert.deepEqual(rt.start({ kind: "child", label: "other", note: "" }), { id: "w2" });
  assert.equal(rt.active, 2);
});

test("child wait: a named wait still wins over any, also for a taken notice", () => {
  const { rt, taken } = runtime(true);
  rt.start({ kind: "child", label: "any", note: "" });
  rt.start({ kind: "child", label: "b", note: "" });
  assert.equal(rt.childNotice("b", "result", "/r.md", true), true);
  assert.equal(taken[0].id, "w2");
  assert.equal(rt.childNotice("b", "result", "/r.md", true), true, "the any wait takes the next one");
  assert.equal(taken[1].id, "w1");
  assert.equal(rt.active, 0);
});

test("child wait: a taken notice ends the wait through `taken`, with no wake and a taken record", () => {
  const { rt, wakes, taken, traces } = runtime(true);
  rt.start({ kind: "child", label: "job", note: "n" });
  assert.equal(rt.childNotice("job", "result", "/h/result.md", true), true);
  assert.equal(rt.active, 0);
  assert.equal(wakes.length, 0);
  assert.equal(taken.length, 1);
  assert.equal(taken[0].id, "w1");
  assert.equal(taken[0].note, "n");
  assert.equal(taken[0].outcome, "child job: result /h/result.md");
  assert.deepEqual(traces.filter((t) => t.decision === "taken"), [{ event: "wait", decision: "taken", toolFamily: "child" }]);
  assert.equal(traces.some((t) => t.decision === "resolved"), false);
  assert.equal(rt.childNotice("job", "result", "/h/result.md", true), false, "not replayed");
});

test("child wait: carried but no run in progress resolves as before; a run in progress without carried too", () => {
  const idle = runtime(false);
  idle.rt.start({ kind: "child", label: "job", note: "" });
  idle.rt.childNotice("job", "result", "/p", true);
  assert.equal(idle.wakes.length, 1);
  assert.equal(idle.taken.length, 0);
  const busy = runtime(true);
  busy.rt.start({ kind: "child", label: "job", note: "" });
  busy.rt.childNotice("job", "result", "/p");
  assert.equal(busy.wakes.length, 1);
  assert.equal(busy.taken.length, 0);
});

test("child wait: another wait's pending outcome is flushed when a taken notice ends the last active wait", () => {
  const { rt, wakes, taken, fns } = runtime(true);
  rt.start({ kind: "timer", seconds: 5, note: "t" });
  rt.start({ kind: "child", label: "job", note: "" });
  const timer = [...fns.values()].find((f) => f.ms === 5000)!;
  timer.fn();
  assert.equal(wakes.length, 0, "held by the batch window while the child wait is active");
  assert.equal(rt.childNotice("job", "result", "/p", true), true);
  assert.equal(taken.length, 1);
  assert.equal(wakes.length, 1, "the timer outcome goes out now");
  assert.equal(wakes[0][0].kind, "timer");
});
