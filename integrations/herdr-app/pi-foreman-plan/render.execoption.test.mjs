import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../pi-foreman/stubs-hooks.mjs", import.meta.url);
const stubs = await import("../pi-foreman/stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

const boot = () => {
  const cx = { spawn: (f) => f(cx), notify() {}, timer: { every() {} }, sleep: () => new Promise(() => {}) };
  const m = Object.create(Mod.prototype);
  m.init({}, cx);
  return m;
};

test("an `i/o timeout` network rejection keeps the copy passing timeout", async () => {
  world.execCalls = [];
  world.execFn = () => { throw new Error("dial tcp 10.0.0.1:22: i/o timeout"); };
  const m = boot();
  await assert.rejects(m.execT("x", [], {}, 5000), /i\/o timeout/);
  assert.equal(m.noTimeout, false);
  assert.equal(world.execCalls.length, 1);
  world.execFn = undefined;
});

test("a real option error still falls back", async () => {
  world.execCalls = [];
  world.execFn = (_c, _a, o) => { if (o && "timeout" in o) throw new TypeError("bad options"); return { code: 0, stdout: "" }; };
  const m = boot();
  await m.execT("x", [], {}, 5000);
  assert.equal(m.noTimeout, true);
  assert.deepEqual(world.execCalls.map((c) => c[2]), [{ timeout: 5000 }, {}]);
  world.execFn = undefined;
});
