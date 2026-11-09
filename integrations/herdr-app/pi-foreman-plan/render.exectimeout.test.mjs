import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../pi-foreman/stubs-hooks.mjs", import.meta.url);
const stubs = await import("../pi-foreman/stubs.mjs");
const { default: Mod } = await import("./main.js");
const { default: Radar } = await import("../pi-foreman/main.js");
const { world } = stubs;

const boot = (M) => {
  const cx = { spawn: (f) => f(cx), notify() {}, timer: { every() {} }, sleep: () => new Promise(() => {}) };
  const m = Object.create(M.prototype);
  m.init({}, cx);
  return { m, cx };
};
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

test("the plan panel and the radar mod, and two plan panels, share no state", () => {
  const a = boot(Mod).m, b = boot(Mod).m, r = boot(Radar).m;
  for (const k of ["recs", "watched", "noteSeen", "diagOk"]) assert.notEqual(a[k], b[k], `${k} is per copy`);
  assert.notEqual(a.recs, r.recs);
  a.noteSeen.set("x", 1); a.noTimeout = true;
  assert.equal(b.noteSeen.size, 0);
  assert.equal(b.noTimeout, false);
  assert.equal(r.noteSeen.size, 0);
});

test("the URL opener carries its timeout and falls back without it when the option is rejected", async () => {
  world.execCalls = [];
  world.execFn = (_c, _a, o) => { if (o && "timeout" in o) throw new Error("timeout must be a positive number of milliseconds"); return { code: 0, stdout: "" }; };
  const a = boot(Mod), b = boot(Mod);
  a.m.openUrl("https://example.org/a", a.cx);
  await settle();
  assert.deepEqual(world.execCalls.map((c) => c[2]), [{ timeout: 10000 }, {}]);
  assert.equal(a.m.noTimeout, true);
  assert.equal(b.m.noTimeout, false);
  a.m.openUrl("https://example.org/a", a.cx);
  await settle();
  assert.deepEqual(world.execCalls.at(-1)[2], {});
  assert.equal(world.execCalls.length, 3);
  world.execFn = undefined;
});

test("a run stopped by the timeout is not retried and does not throw", async () => {
  world.execCalls = [];
  world.execFn = () => { throw new Error("xdg-open took longer than 10 s and was stopped"); };
  const { m, cx } = boot(Mod);
  m.openUrl("https://example.org/a", cx);
  await settle();
  assert.equal(world.execCalls.length, 1);
  assert.equal(m.noTimeout, false);
  world.execFn = undefined;
});
