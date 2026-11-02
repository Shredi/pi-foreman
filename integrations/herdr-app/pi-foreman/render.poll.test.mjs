import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");

const GOOD = { ok: true, tree: [], openPrs: [], openPrsAt: null, tried: 0 };

function mod(radar = []) {
  const m = Object.create(Mod.prototype);
  m.radar = new Map(radar); m.busy = new Map(); m.recs = new Map(); m.childPi = new Set();
  m.foremanProp = undefined; m.hcProp = undefined;
  return m;
}
const recorder = () => { const tasks = []; return { tasks, cx: { spawn: (f) => tasks.push(f), notify() {}, sleep: () => new Promise(() => {}) } }; };

test("a radar poll that never came back is freed after 45 s and polled again", () => {
  const m = mod();
  const a = recorder();
  m.poll(a.cx);
  assert.equal(a.tasks.length, 1);
  m.poll(a.cx);
  assert.equal(a.tasks.length, 1, "still busy");
  m.busy.set("local", Date.now() - 46000);
  m.poll(a.cx);
  assert.equal(a.tasks.length, 2, "freed and polled again");
});

test("an hc records poll that never came back is freed after 45 s too", () => {
  stubs.world.agents = [{ address: "a/1", app: "pi" }];
  const m = mod([["local", { ...GOOD, tried: Date.now() }]]);
  const a = recorder();
  m.poll(a.cx);
  assert.equal(a.tasks.length, 1);
  assert.ok(m.busy.has("hc:a/1"));
  m.busy.set("hc:a/1", Date.now() - 46000);
  m.poll(a.cx);
  assert.equal(a.tasks.length, 2);
  stubs.world.agents = [];
});

test("a failed radar read keeps the last good data for up to 5 misses", async () => {
  const m = mod([["local", { ...GOOD }]]);
  const a = recorder();
  for (let i = 1; i <= 6; i++) {
    m.radar.get("local").tried = 0;
    m.busy.clear();
    m.poll(a.cx);
    await a.tasks.at(-1)(a.cx);
    const rec = m.radar.get("local");
    if (i <= 5) assert.deepEqual([rec.ok, rec.misses], [true, i], `miss ${i}`);
    else assert.equal(rec.ok, false, "sixth miss drops the data");
  }
});
