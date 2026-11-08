import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../pi-foreman/stubs-hooks.mjs", import.meta.url);
const stubs = await import("../pi-foreman/stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

const A = "/w/plan-a.md";
const C = "/w/plan-c.md";
const D = "/w/plan-d.md";
const node = (key, hc, show, parent = "") => ({ key, kind: "session", name: key, hcTerminal: hc, pid: null, parent, state: "working", ...(show ? { show } : {}), children: [] });
const meta = (path) => JSON.stringify({ path, title: "P", v: 1, at: "2026-11-06T10:00:00Z", hash: "h1", ruledPath: null, prevHash: null, fences: [] });

// A Map whose reads can be held: next(path) releases the oldest held read of that path.
class Gated extends Map {
  constructor(entries) { super(entries); this.gate = new Map(); }
  hold(path) { if (!this.gate.has(path)) this.gate.set(path, []); }
  next(path) { const q = this.gate.get(path); const f = q?.shift(); if (f) f(); }
  flush(path) { while (this.gate.get(path)?.length) this.next(path); this.gate.delete(path); }
  get(path) {
    const v = super.get(path) ?? null;
    const q = this.gate.get(path);
    if (!q) return v;
    return new Promise((r) => q.push(() => r(v)));
  }
}

function reset() {
  world.files = new Gated([
    ["/s/fm/plan.json", meta(A)], [A, "# Plan A\n\nAlpha body.\n"],
    ["/s/c1/plan.json", meta(C)], [C, "# Plan C\n\nGamma body.\n"],
    ["/s/d/plan.json", meta(D)], [D, "# Plan D\n\nDelta body.\n"],
  ]);
  world.reads = []; world.runCalls = []; world.execCalls = [];
  world.shared = {
    "pi-foreman.radar": { machines: { local: [
      node("fm", "t1", { dir: "/s/fm", plan: 1 }),
      node("c1", "tc1", { dir: "/s/c1", plan: 1 }, "fm"),
      node("bare", "t8", null),
      node("bc", "t7", { dir: "/s/d", plan: 1 }, "bare"),
    ] } },
  };
  world.agents = [{ address: "t1", tab: "tabA", pane: "p1" }];
  world.panes = [{ pane: "p1", tab: "tabA", terminal: "t1" }];
  world.terminals = [];
  world.focus = { space: "s", tab: "tabA", pane: "p1", terminal: "t1", shown: null, agent: "t1", cwd: null };
}
const boot = () => {
  const cx = { notified: 0, spawn(f) { f(cx); }, notify() { cx.notified++; }, timer: { every() {} }, sleep: () => new Promise(() => {}) };
  const m = Object.create(Mod.prototype);
  m.init({}, cx);
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  return { m, cx, settle };
};
const walk = (el, out = []) => { if (el && typeof el === "object") { out.push(el); for (const k of el.kids ?? []) walk(k, out); } return out; };
const strings = (el) => walk(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));
const mds = (el) => walk(el).filter((e) => e.kind === "TextView").map((v) => v.md);
let n = 0;
const click = (key) => { world.shared["pi-foreman.show"] = { n: ++n, key, kind: "plan" }; };

test("a tab without a document releases the held plan and shows the empty state; a foreign root does too", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  m.render(cx);
  click("bare"); m.render(cx); await settle();
  m.tab = "c:bc"; m.render(cx); await settle();
  assert.ok(mds(m.render(cx)).some((t) => t.includes("Delta body")), "the child tab shows its plan");
  m.tab = "plan";
  m.render(cx); await settle();
  const empty = m.render(cx);
  assert.ok(strings(empty).includes("No plan published by this session"), "the empty state shows");
  assert.ok(!mds(empty).some((t) => t.includes("Delta body")), "the old body is not held");

  click("fm"); m.render(cx); await settle();
  assert.ok(mds(m.render(cx)).some((t) => t.includes("Alpha body")));
  click("bare"); m.render(cx); await settle();
  const foreign = m.render(cx);
  assert.ok(!mds(foreign).some((t) => t.includes("Alpha body")), "a root change drops the held doc");
  assert.ok(strings(foreign).includes("No plan published by this session"));
});

test("from a planless view a click on a child whose read is pending shows Loading, then the plan", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  m.render(cx);
  click("bare"); m.render(cx); await settle();
  assert.ok(strings(m.render(cx)).includes("No plan published by this session"));
  assert.ok(!m.recs.get("local|/s/d")?.ready, "the child is not read yet");
  world.files.hold("/s/d/plan.json");
  m.tick(cx); // the planless root's prefetch starts the child read, which is held
  m.tab = "c:bc";
  const loading = m.render(cx);
  assert.ok(!strings(loading).includes("No plan published by this session"), "no empty state while the read is pending");
  assert.ok(strings(loading).includes("Loading plan…"));
  world.files.flush("/s/d/plan.json"); await settle();
  assert.ok(mds(m.render(cx)).some((t) => t.includes("Delta body")));
});

test("a planless root still prefetches its children", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  click("bare"); m.render(cx); await settle();
  assert.ok(!m.recs.get("local|/s/d")?.ready, "nothing reads the child before the tick");
  m.tick(cx); await settle();
  assert.ok(m.recs.get("local|/s/d")?.ready, "child read without being selected");
});

test("a prefetch read superseded by the click read of the same key neither marks ready nor shows the empty state", async () => {
  reset();
  world.files.hold("/s/c1/plan.json");
  const { m, cx, settle } = boot(); await settle();
  m.render(cx); // prefetch of c1 is waiting on plan.json
  click("c1"); m.render(cx); await settle(); // the click read queues behind it
  world.files.next("/s/c1/plan.json"); // the prefetch read answers first and is superseded
  await settle();
  const rec = m.recs.get("local|/s/c1");
  assert.ok(!rec.ready, "the record is not ready until the real read");
  assert.ok(!strings(m.render(cx)).includes("No plan published by this session"), "no empty frame");
  world.files.flush("/s/c1/plan.json"); await settle();
  assert.ok(m.recs.get("local|/s/c1").ready);
  assert.ok(mds(m.render(cx)).some((t) => t.includes("Gamma body")));
});
