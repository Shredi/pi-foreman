import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../pi-foreman/stubs-hooks.mjs", import.meta.url);
const stubs = await import("../pi-foreman/stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

const node = (key, hc, show, parent = "") => ({ key, kind: "session", name: key, hcTerminal: hc, pid: null, parent, state: "working", ...(show ? { show } : {}), children: [] });
const index = (title) => JSON.stringify({ v: 1, pages: [{ id: "plan", kind: "plan", title, state: "draft", version: 1, at: "2026-11-06T10:00:00Z", file: "plan.html" }], events: [] });

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
    ["/s/fm/pages/pages.json", index("Alpha page")],
    ["/s/c1/pages/pages.json", index("Gamma page")],
    ["/s/d/pages/pages.json", index("Delta page")],
  ]);
  world.reads = []; world.runCalls = []; world.execCalls = [];
  world.shared = {
    "pi-foreman.radar": { machines: { local: [
      node("fm", "t1", { dir: "/s/fm" }),
      node("c1", "tc1", { dir: "/s/c1" }, "fm"),
      node("bare", "t8", null),
      node("bc", "t7", { dir: "/s/d" }, "bare"),
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
let n = 0;
const click = (key) => { world.shared["pi-foreman.show"] = { n: ++n, key, kind: "plan" }; };
const EMPTY = "No pages published by this session";

test("a tab without a show folder shows the empty state; a foreign root does too", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  m.render(cx);
  click("bare"); m.render(cx); await settle();
  m.tab = "c:bc"; m.render(cx); await settle();
  assert.ok(strings(m.render(cx)).includes("Delta page"), "the child tab lists its page");
  m.tab = "foreman";
  m.render(cx); await settle();
  const empty = m.render(cx);
  assert.ok(strings(empty).includes(EMPTY), "the empty state shows");
  assert.ok(!strings(empty).includes("Delta page"), "the other tab's page is not listed");

  click("fm"); m.render(cx); await settle();
  assert.ok(strings(m.render(cx)).includes("Alpha page"));
  click("bare"); m.render(cx); await settle();
  const foreign = m.render(cx);
  assert.ok(!strings(foreign).includes("Alpha page"), "a root change drops the list");
  assert.ok(strings(foreign).includes(EMPTY));
});

test("from a tab without pages a click on a child whose read is pending shows Loading, then the list", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  m.render(cx);
  click("bare"); m.render(cx); await settle();
  assert.ok(strings(m.render(cx)).includes(EMPTY));
  assert.ok(!m.recs.get("local|/s/d")?.ready, "the child is not read yet");
  world.files.hold("/s/d/pages/pages.json");
  m.tick(cx); // the root without pages starts the child's read-ahead, which is held
  m.tab = "c:bc";
  const loading = m.render(cx);
  assert.ok(!strings(loading).includes(EMPTY), "no empty state while the read is pending");
  assert.ok(strings(loading).includes("Loading pages…"));
  world.files.flush("/s/d/pages/pages.json"); await settle();
  assert.ok(strings(m.render(cx)).includes("Delta page"));
});

test("a root without a show folder still reads its children ahead", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  click("bare"); m.render(cx); await settle();
  assert.ok(!m.recs.get("local|/s/d")?.ready, "nothing reads the child before the tick");
  m.tick(cx); await settle();
  assert.ok(m.recs.get("local|/s/d")?.ready, "child read without being selected");
});

test("a read-ahead superseded by the click read of the same key neither marks ready nor shows the empty state", async () => {
  reset();
  world.files.hold("/s/c1/pages/pages.json");
  const { m, cx, settle } = boot(); await settle();
  m.render(cx); // the read-ahead of c1 is waiting on pages.json
  click("c1"); m.render(cx); await settle(); // the click read queues behind it
  world.files.next("/s/c1/pages/pages.json"); // the read-ahead answers first and is superseded
  await settle();
  const rec = m.recs.get("local|/s/c1");
  assert.ok(!rec.ready, "the record is not ready until the real read");
  assert.ok(!strings(m.render(cx)).includes(EMPTY), "no empty frame");
  world.files.flush("/s/c1/pages/pages.json"); await settle();
  assert.ok(m.recs.get("local|/s/c1").ready);
  assert.ok(strings(m.render(cx)).includes("Gamma page"));
});
