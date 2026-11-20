import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const { world } = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");

test("an hc get poll whose only change is a background-agents record id redraws", async () => {
  world.agents = [{ address: "a/1", app: "pi" }];
  const hc = (id) => JSON.stringify({ records: { [id]: { app: "pi-foreman", state: "working", title: "t", msg: "m" } } });
  const m = Object.create(Mod.prototype);
  m.radar = new Map([["local", { ok: true, tree: [], openPrs: [], openPrsAt: null, tried: Date.now() }]]);
  m.busy = new Map(); m.recs = new Map(); m.childPi = new Set(); m.changed = {};
  const tasks = [];
  const c = { n: 0, spawn: (f) => tasks.push(f), notify() { c.n++; }, sleep: () => new Promise(() => {}) };
  const poll = async (text) => {
    world.execFn = () => ({ code: 0, stdout: text });
    m.busy.clear();
    const have = m.recs.get("a/1");
    if (have) have.tried = 0;
    tasks.length = 0;
    m.pollRecords(c, Date.now());
    await tasks[0](c);
  };
  try {
    await poll(hc("background-agents/one"));
    assert.equal(c.n, 1);
    await poll(hc("background-agents/one"));
    assert.equal(c.n, 1, "same id: no redraw");
    await poll(hc("background-agents/two"));
    assert.equal(c.n, 2, "id-only change redraws");
  } finally { world.execFn = undefined; world.agents = []; }
});
