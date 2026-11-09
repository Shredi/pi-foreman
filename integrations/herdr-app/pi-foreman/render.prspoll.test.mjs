import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");

function mod(machines = [null]) {
  const m = Object.create(Mod.prototype);
  m.radar = new Map(); m.busy = new Map(); m.recs = new Map(); m.childPi = new Set();
  m.foremanProp = undefined; m.hcProp = undefined;
  m.machines = () => machines;
  return m;
}
const recorder = () => {
  const tasks = [];
  const sleeps = [];
  return { tasks, sleeps, cx: { spawn: (f) => tasks.push(f), notify() {}, sleep: (ms) => { sleeps.push(ms); return new Promise(() => {}); } } };
};
const prsCalls = () => stubs.world.execCalls.filter((c) => c[1]?.[0] === "prs");

test("pollPrs execs `foreman prs poll --json` on each machine, once, under the busy key prs:<machine>", async () => {
  stubs.world.execCalls.length = 0;
  const m = mod([null, "alpha"]);
  const a = recorder();
  m.pollPrs(a.cx, Date.now());
  assert.equal(a.tasks.length, 2);
  assert.ok(m.busy.has("prs:local") && m.busy.has("prs:alpha"));
  m.pollPrs(a.cx, Date.now());
  assert.equal(a.tasks.length, 2, "busy: not started twice");
  for (const t of a.tasks) await t(a.cx);
  const calls = prsCalls();
  assert.deepEqual(calls.map((c) => [c[1], c[2]]), [[["prs", "poll", "--json"], { on: null, timeout: 600000 }], [["prs", "poll", "--json"], { on: "alpha", timeout: 600000 }]]);
  assert.equal(m.busy.size, 0, "the key is freed when the run ends");
});

test("the next run starts 30 s after the previous one ended, not before", async () => {
  const m = mod();
  const a = recorder();
  m.pollPrs(a.cx, Date.now());
  await a.tasks[0](a.cx);
  m.pollPrs(a.cx, Date.now() + 10000);
  assert.equal(a.tasks.length, 1, "10 s after the end: wait");
  m.pollPrs(a.cx, Date.now() + 31000);
  assert.equal(a.tasks.length, 2, "31 s after the end: run");
});

test("the watchdog gives a run up after 20 min and a run lost for 21 min frees its key", () => {
  const m = mod();
  const a = recorder();
  m.pollPrs(a.cx, Date.now());
  a.tasks[0](a.cx);
  assert.deepEqual(a.sleeps, [20 * 60000]);
  m.pollPrs(a.cx, Date.now() + 20 * 60000);
  assert.equal(a.tasks.length, 1, "still busy at 20 min");
  m.busy.set("prs:local", Date.now() - 22 * 60000);
  m.pollPrs(a.cx, Date.now());
  assert.equal(a.tasks.length, 2, "freed after 21 min");
});

test("a failing exec is ignored and poll() still starts only the radar read", async () => {
  const m = mod();
  const a = recorder();
  m.pollPrs(a.cx, Date.now());
  await assert.doesNotReject(a.tasks[0](a.cx));
  const b = recorder();
  m.poll(b.cx);
  assert.equal(b.tasks.length, 1, "poll(): one radar task, no prs task");
  assert.ok(m.busy.has("local") && !m.busy.has("prs:local"));
});
