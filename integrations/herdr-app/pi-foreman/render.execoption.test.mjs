import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

const boot = () => {
  const tasks = [];
  const cx = { spawn: (f) => tasks.push(f), notify() {}, timer: { every() {} }, sleep: () => new Promise(() => {}) };
  const m = Object.create(Mod.prototype);
  m.init({}, cx);
  tasks.length = 0;
  return { m, tasks, cx };
};
const reset = () => { world.execCalls = []; world.notices = []; world.execFn = undefined; world.agents = []; world.spaces = []; };

test("an `i/o timeout` network rejection is no option error: the copy keeps passing timeout", async () => {
  reset();
  const { m } = boot();
  world.execFn = () => { throw new Error("dial tcp 10.0.0.1:22: i/o timeout"); };
  await assert.rejects(m.execT("x", [], {}, 5000), /i\/o timeout/);
  assert.equal(m.noTimeout, false);
  assert.equal(world.execCalls.length, 1, "not retried");
  world.execFn = undefined;
  world.execCalls = [];
  await m.execT("x", [], {}, 5000);
  assert.deepEqual(world.execCalls[0][2], { timeout: 5000 });
});

test("two failed attaches post two error notices", async () => {
  reset();
  world.execFn = () => { throw new Error("hc failed"); };
  const { m, tasks, cx } = boot();
  m.terms = [];
  for (let i = 0; i < 2; i++) {
    m.openRemote({ machine: "m", hcTerminal: "t1", key: "k", name: "n" }, cx);
    await tasks.shift()();
  }
  assert.equal(world.notices.length, 2);
  assert.ok(world.notices.every((n) => n.level === "error"));
});

test("a real option error still falls back", async () => {
  reset();
  const { m } = boot();
  world.execFn = (_c, _a, o) => { if (o && "timeout" in o) throw new Error("unexpected option: timeout"); return { code: 0, stdout: "" }; };
  await m.execT("x", [], {}, 5000);
  assert.equal(m.noTimeout, true);
  assert.deepEqual(world.execCalls.map((c) => c[2]), [{ timeout: 5000 }, {}]);
});
