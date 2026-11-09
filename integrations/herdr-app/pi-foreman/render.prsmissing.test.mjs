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
// The texts Herdr 0.1.14 gives when the program does not start (herdr-app src/mods.rs, src/programs.rs).
const notFound = () => { throw new Error("herdr.exec: cannot start foreman: program not found"); };
const noSuchFile = () => { throw new Error("herdr.exec: cannot run foreman: No such file or directory"); };
const stopped = () => { throw new Error("foreman prs poll took longer than 600 s and was stopped"); };

test("a missing foreman binary (program not found) posts no PR-poll notice", async () => {
  reset();
  world.execFn = notFound;
  const { m, tasks, cx } = boot();
  for (const t of tasks.splice(0)) await t(cx);
  assert.equal(world.execCalls.filter((c) => c[1][0] === "prs").length, 1);
  assert.deepEqual(world.notices, []);
  assert.equal(m.busy.has("prs:local"), false, "the key is freed");
});

test("a missing foreman binary (no such file) posts no PR-poll notice, on a remote machine too", async () => {
  reset();
  world.execFn = noSuchFile;
  world.spaces = [{ id: 1, machine: "alpha" }];
  const { tasks, cx } = boot();
  for (const t of tasks.splice(0)) await t(cx);
  assert.equal(world.execCalls.filter((c) => c[1][0] === "prs").length, 2, "local and alpha");
  assert.deepEqual(world.notices, []);
  world.spaces = [];
});

test("a timeout posts one PR-poll notice; a missing binary after it posts none and clears the failure, so a later timeout notifies again", async () => {
  reset();
  world.execFn = stopped;
  const { m, tasks, cx } = boot();
  for (const t of tasks.splice(0)) await t(cx);
  assert.equal(world.notices.length, 1);
  assert.equal(world.notices[0].level, "error");
  assert.match(world.notices[0].body, /was stopped/);
  // the same failure again: no second notice
  m.prsRan.clear();
  m.pollPrs(cx, Date.now());
  for (const t of tasks.splice(0)) await t(cx);
  assert.equal(world.notices.length, 1);
  // the binary goes missing: no notice, and the failure state is cleared
  world.execFn = notFound;
  m.prsRan.clear();
  m.pollPrs(cx, Date.now());
  for (const t of tasks.splice(0)) await t(cx);
  assert.equal(world.notices.length, 1);
  assert.equal(m.failed.has("prs:local"), false);
  // a later timeout notifies again
  world.execFn = stopped;
  m.prsRan.clear();
  m.pollPrs(cx, Date.now());
  for (const t of tasks.splice(0)) await t(cx);
  assert.equal(world.notices.length, 2);
});

test("a missing binary followed by a timeout still notifies once for the timeout", async () => {
  reset();
  world.execFn = notFound;
  const { m, tasks, cx } = boot();
  for (const t of tasks.splice(0)) await t(cx);
  assert.deepEqual(world.notices, []);
  world.execFn = stopped;
  m.prsRan.clear();
  m.pollPrs(cx, Date.now());
  for (const t of tasks.splice(0)) await t(cx);
  assert.equal(world.notices.length, 1);
  assert.match(world.notices[0].body, /was stopped/);
});

test("the radar still shows its own state when foreman is missing: no notice from the radar read either", async () => {
  reset();
  world.execFn = notFound;
  const { m, tasks, cx } = boot();
  for (const t of tasks.splice(0)) await t(cx);
  assert.deepEqual(world.notices, []);
  assert.equal(m.radar.get("local").ok, false);
  assert.doesNotThrow(() => m.render(cx));
});
