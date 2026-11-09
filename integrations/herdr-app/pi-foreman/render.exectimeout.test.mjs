import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

const recorder = () => {
  const tasks = [];
  const cx = { spawn: (f) => tasks.push(f), notify() {}, timer: { every() {} }, sleep: () => new Promise(() => {}) };
  return { tasks, cx };
};
const boot = () => {
  const r = recorder();
  const m = Object.create(Mod.prototype);
  m.init({}, r.cx);
  return { m, ...r };
};
const reset = () => { world.execCalls = []; world.notices = []; world.execFn = undefined; world.agents = []; world.spaces = []; };
const optionError = (_cmd, _args, opts) => { if (opts && "timeout" in opts) throw new Error("unknown option: timeout"); return { code: 1, stdout: "" }; };
const stopped = () => { throw new Error("foreman took longer than 600 s and was stopped"); };

test("two copies made from one import share no state", async () => {
  reset();
  const a = boot();
  const b = boot();
  for (const k of ["changed", "feed", "folded", "radar", "busy", "recs", "childPi", "noteSeen", "shows", "prsRan", "failed"]) {
    assert.notEqual(a.m[k], b.m[k], `${k} is per copy`);
  }
  a.m.noteSeen.set("x", 1); a.m.folded.add("f"); a.m.noTimeout = true; a.m.failed.add("k");
  assert.equal(b.m.noteSeen.size, 0);
  assert.equal(b.m.folded.size, 0);
  assert.equal(b.m.noTimeout, false);
  assert.equal(b.m.failed.size, 0);
});

test("every exec of the mod carries its timeout", async () => {
  reset();
  world.agents = [{ address: "a/1", app: "pi" }, { address: "t2", app: "pi" }];
  world.spaces = [{ id: 1, machine: "a" }];
  const { m, tasks, cx } = boot();
  for (const t of tasks.splice(0)) await t(cx);
  const call = (pred) => world.execCalls.find(pred)?.[2];
  assert.deepEqual(call((c) => c[1][0] === "radar" && c[2].on === null), { on: null, timeout: 30000 });
  assert.deepEqual(call((c) => c[1][0] === "prs"), { on: null, timeout: 600000 });
  assert.deepEqual(call((c) => c[1][0] === "get" && c[2].on === "a"), { on: "a", timeout: 15000 });
  assert.deepEqual(call((c) => c[1][0] === "get" && c[2].on === null), { on: null, timeout: 10000 });
  assert.equal(m.noTimeout, false);
  world.agents = []; world.spaces = [];
});

test("an exec that rejects the timeout option runs again without it, and this copy stops passing it", async () => {
  reset();
  world.execFn = optionError;
  const a = boot();
  const b = boot();
  for (const t of a.tasks.splice(0)) await t(a.cx);
  const opts = world.execCalls.map((c) => c[2]);
  assert.deepEqual(opts.slice(0, 2), [{ on: null, timeout: 30000 }, { on: null }], "the radar read: one try with, one without");
  assert.ok(opts.slice(2).every((o) => !("timeout" in o)), "every later call passes none");
  assert.ok(world.execCalls.some((c) => c[1][0] === "prs"));
  assert.equal(a.m.noTimeout, true);
  assert.equal(b.m.noTimeout, false, "the other copy is untouched");
  assert.deepEqual(world.notices, [], "no error notice for an option fallback");
  world.execCalls.length = 0;
  await a.m.execT("x", [], { on: null }, 5000);
  assert.deepEqual(world.execCalls, [["x", [], { on: null }]], "later calls pass no timeout");
});

test("a run stopped by the timeout is no option error: no retry; the prs poll posts one error notice per failure", async () => {
  reset();
  world.execFn = stopped;
  const { m, tasks, cx } = boot();
  for (const t of tasks.splice(0)) await t(cx);
  assert.equal(world.execCalls.filter((c) => c[1][0] === "prs").length, 1, "not retried");
  assert.equal(m.noTimeout, false);
  assert.equal(world.notices.length, 1);
  assert.equal(world.notices[0].level, "error");
  assert.match(world.notices[0].body, /was stopped/);
  // still failing next round: no second notice; after a good run a new failure notifies again
  m.prsRan.clear();
  m.pollPrs(cx, Date.now());
  for (const t of tasks.splice(0)) await t(cx);
  assert.equal(world.notices.length, 1);
  world.execFn = () => ({ code: 0, stdout: "{}" });
  m.prsRan.clear();
  m.pollPrs(cx, Date.now());
  for (const t of tasks.splice(0)) await t(cx);
  world.execFn = stopped;
  m.prsRan.clear();
  m.pollPrs(cx, Date.now());
  for (const t of tasks.splice(0)) await t(cx);
  assert.equal(world.notices.length, 2);
});

test("the watchdog backstop of a prs poll posts the error notice too", async () => {
  reset();
  world.execFn = () => new Promise(() => {});
  const r = recorder();
  r.cx.sleep = () => Promise.resolve();
  const m = Object.create(Mod.prototype);
  m.init({}, r.cx);
  await Promise.all(r.tasks.splice(0).map((t) => t(r.cx)));
  assert.equal(world.notices.length, 1);
  assert.equal(world.notices[0].level, "error");
  assert.equal(m.busy.has("prs:local"), false);
});

test("a rejected radar exec renders the existing error state: no hang, no throw", async () => {
  reset();
  world.execFn = stopped;
  const { m, tasks, cx } = boot();
  for (const t of tasks.splice(0)) await t(cx);
  assert.deepEqual([m.radar.get("local").ok, m.busy.has("local")], [false, false]);
  assert.doesNotThrow(() => m.render(cx));
});

test("a failed attach posts one error notice", async () => {
  reset();
  world.execFn = stopped;
  const { m, tasks, cx } = boot();
  tasks.length = 0;
  m.terms = [];
  m.openRemote({ machine: "m", hcTerminal: "t1", key: "k", name: "n" }, cx);
  assert.equal(tasks.length, 1);
  await tasks.shift()();
  assert.equal(world.execCalls.at(-1)[2].timeout, 15000);
  assert.equal(world.notices.length, 1);
  assert.equal(world.notices[0].level, "error");
});
