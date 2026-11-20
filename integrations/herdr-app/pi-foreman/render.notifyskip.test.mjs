import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");

const mod = () => {
  const m = Object.create(Mod.prototype);
  m.changed = {};
  return m;
};
const cx = () => { const c = { n: 0, notify() { c.n++; } }; return c; };

test("the 1 s tick redraws only when a clock's text changed", () => {
  const m = mod();
  const real = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    assert.equal(m.clock("a", (n) => `${Math.floor((n - 1_000_000) / 60000)}m`, now), "0m");
    const c = cx();
    now += 30_000; m.tickClocks(c);
    assert.equal(c.n, 0, "same text: no redraw");
    now += 31_000; m.tickClocks(c);
    assert.equal(c.n, 1, "the text moved to 1m");
  } finally { Date.now = real; }
});

test("the legend closes after the pointer left for a second, and a tick with nothing else redraws only then", () => {
  const m = mod();
  const real = Date.now;
  let now = 5_000_000;
  Date.now = () => now;
  try {
    m.legendHot = true; m.legendLeft = now;
    const c = cx();
    now += 500; m.tickClocks(c);
    assert.equal(c.n, 0); assert.equal(m.legendHot, true);
    now += 600; m.tickClocks(c);
    assert.equal(c.n, 1); assert.equal(m.legendHot, false);
  } finally { Date.now = real; }
});

// ---- poll handlers: stored always, redrawn only when what is shown changed ----------------------------------------
const { world } = await import("./stubs.mjs");

const GOOD = { ok: true, tree: [], openPrs: [], openPrsAt: null, tried: 0 };
const pollMod = (radar = []) => {
  const m = Object.create(Mod.prototype);
  m.radar = new Map(radar); m.busy = new Map(); m.recs = new Map(); m.childPi = new Set();
  m.foremanProp = undefined; m.hcProp = undefined; m.changed = {};
  return m;
};
const live = () => { const tasks = []; const c = { n: 0, tasks, spawn: (f) => tasks.push(f), notify() { c.n++; }, sleep: () => new Promise(() => {}) }; return c; };
const doc = (over = {}) => JSON.stringify({ roots: [{ kind: "session", key: "k", name: "a", state: "working", waits: [], tasks: [], ...over }], openPrs: [], now: "2026-01-01T00:00:00Z" });

async function radarPoll(m, c, text) {
  world.execFn = () => ({ code: 0, stdout: text });
  m.radar.get("local") && (m.radar.get("local").tried = 0);
  m.busy.clear();
  c.tasks.length = 0;
  m.poll(c);
  await c.tasks[0](c); // the radar task is the first one spawned
}

test("a radar poll with an identical document stores the new record but does not redraw", async () => {
  const m = pollMod(); const c = live();
  try {
    await radarPoll(m, c, doc());
    assert.equal(c.n, 1, "first sight redraws");
    const first = m.radar.get("local");
    await radarPoll(m, c, doc());
    assert.equal(c.n, 1, "same document: no redraw");
    assert.notEqual(m.radar.get("local"), first, "the record is still replaced");
    assert.ok(m.radar.get("local").tried >= first.tried);
    await radarPoll(m, c, doc({ state: "blocked" }));
    assert.equal(c.n, 2, "a changed state redraws");
  } finally { world.execFn = undefined; }
});

test("a radar age moving inside its fmtAge label does not redraw; across a label it does", async () => {
  for (const [name, mk] of [
    ["wait", (s) => ({ waits: [{ kind: "x", note: "n", age_s: s }] })],
    ["blocked", (s) => ({ blocked_s: s })],
    ["task", (s) => ({ tasks: [{ id: "t", label: "l", ageSeconds: s }] })],
  ]) {
    const m = pollMod(); const c = live();
    try {
      await radarPoll(m, c, doc(mk(100)));
      const n0 = c.n;
      await radarPoll(m, c, doc(mk(101)));
      assert.equal(c.n, n0, `${name}: same label, no redraw`);
      const stored = m.radar.get("local");
      const age = name === "wait" ? stored.nodes[0].waits[0].ageS : name === "blocked" ? stored.nodes[0].blockedS : stored.nodes[0].tasks[0].ageS;
      assert.equal(age, 101, `${name}: the fresh age is stored`);
    } finally { world.execFn = undefined; }
    const m2 = pollMod(); const c2 = live();
    try {
      await radarPoll(m2, c2, doc(mk(59)));
      const n0 = c2.n;
      await radarPoll(m2, c2, doc(mk(60)));
      assert.equal(c2.n, n0 + 1, `${name}: 59 s to 1 m redraws`);
    } finally { world.execFn = undefined; }
  }
});

test("a plan/note read redraws only when the meta changed, and always stores the read", async () => {
  const node = { kind: "session", key: "k", sessions: [], show: { dir: "/d", plan: 1, note: 1 } };
  const m = pollMod([["local", { ...GOOD, tree: [node], tried: Date.now() }]]);
  const c = live();
  const read = async () => {
    c.tasks.length = 0;
    const have = m.shows?.get("local|/d");
    if (have) have.read = 0;
    m.busy.clear();
    m.pollShows(c, Date.now());
    await c.tasks[0](c);
  };
  world.files.set("/d/plan.json", JSON.stringify({ v: 1, at: "2026-01-01T00:00:00Z" }));
  world.files.set("/d/note.json", JSON.stringify({ v: 1, at: "2026-01-01T00:00:00Z" }));
  await read();
  assert.equal(c.n, 1, "first read redraws");
  const readAt = m.shows.get("local|/d").read;
  await new Promise((r) => setTimeout(r, 5));
  await read();
  assert.equal(c.n, 1, "equal read: no redraw");
  assert.ok(m.shows.get("local|/d").read > readAt, "the stored read time is new");
  world.files.set("/d/plan.json", JSON.stringify({ v: 2, at: "2026-01-01T00:00:00Z" }));
  await read();
  assert.equal(c.n, 2, "changed plan redraws");
  world.files.delete("/d/plan.json"); world.files.delete("/d/note.json");
});

test("an hc get poll redraws only when records or the attach target changed, and always stores tried", async () => {
  world.agents = [{ address: "a/1", app: "pi" }];
  const hc = (recs, extra = {}) => JSON.stringify({ records: recs, ...extra });
  const rec = (msg) => ({ r1: { app: "pi-subagents", state: "working", title: "t", msg } });
  const m = pollMod([["local", { ...GOOD, tried: Date.now() }]]);
  const c = live();
  const hcPoll = async (text) => {
    world.execFn = () => ({ code: 0, stdout: text });
    m.busy.clear();
    const have = m.recs.get("a/1");
    if (have) have.tried = 0;
    c.tasks.length = 0;
    m.pollRecords(c, Date.now());
    await c.tasks[0](c);
  };
  try {
    await hcPoll(hc(rec("one")));
    assert.equal(c.n, 1, "first sight redraws");
    const t1 = m.recs.get("a/1").tried;
    await new Promise((r) => setTimeout(r, 5));
    await hcPoll(hc(rec("one")));
    assert.equal(c.n, 1, "equal records: no redraw");
    assert.ok(m.recs.get("a/1").tried > t1, "tried is stored anyway");
    await hcPoll(hc(rec("two")));
    assert.equal(c.n, 2, "changed record redraws");
    await hcPoll(hc(rec("two"), { argv: ["sh", "-c", "hc attach m/t"] }));
    assert.equal(c.n, 3, "a new attach target redraws");
  } finally { world.execFn = undefined; world.agents = []; }
});
