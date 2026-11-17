import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../pi-foreman/stubs-hooks.mjs", import.meta.url);
const stubs = await import("../pi-foreman/stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

const node = (key, hc, show, parent = "") => ({ key, kind: "session", name: key, hcTerminal: hc, pid: null, parent, state: "working", ...(show ? { show } : {}), children: [] });
const index = (title) => JSON.stringify({ v: 1, pages: [{ id: "plan", kind: "plan", title, state: "draft", version: 1, at: "2026-11-06T10:00:00Z", file: "plan.html" }], events: [] });

// A Map whose reads can be held: a held path answers a promise, and next(path) releases its oldest read with the text that
// was there when that read started. readTextFile returns whatever get() answers, so the shared stubs stay as they are.
class Gated extends Map {
  constructor(entries) { super(entries); this.gate = new Map(); }
  hold(path) { if (!this.gate.has(path)) this.gate.set(path, []); }
  next(path) { const q = this.gate.get(path); const f = q?.shift(); if (f) f(); if (q && !q.length) this.gate.delete(path); }
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
    ["/s/dead/pages/pages.json", index("Beta page")],
  ]);
  world.reads = []; world.runCalls = []; world.execCalls = [];
  world.shared = {
    "pi-foreman.radar": { machines: { local: [
      node("fm", "t1", { dir: "/s/fm" }),
      node("c1", "tc1", { dir: "/s/c1" }, "fm"),
      node("dead", "t9", { dir: "/s/dead" }),
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

test("a switch to a session already read renders it in the first frame, with no Loading text", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  m.render(cx);
  click("dead"); m.render(cx); await settle(); // read once
  click("fm"); m.render(cx); await settle();
  click("dead");
  const first = m.render(cx);
  assert.ok(strings(first).includes("Beta page"), "the target is in the first render");
  assert.ok(!strings(first).includes("Loading pages…"));
});

test("a switch to a session not read yet shows Loading until its index is read", async () => {
  reset();
  world.files.hold("/s/dead/pages/pages.json");
  const { m, cx, settle } = boot(); await settle();
  m.render(cx);
  click("dead");
  const during = m.render(cx);
  assert.ok(strings(during).includes("Loading pages…"));
  assert.ok(!strings(during).includes("Alpha page"), "the previous list is not held");
  await settle();
  world.files.flush("/s/dead/pages/pages.json"); await settle();
  const done = m.render(cx);
  assert.ok(strings(done).includes("Beta page"));
  assert.ok(!strings(done).includes("Loading pages…"));
});

test("background read-ahead reads the other tabs after the first paint, so a switch to one renders at once", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  m.render(cx);
  const c1 = m.recs.get("local|/s/c1");
  assert.ok(c1?.ready, "the child tab was read without a click");
  m.tab = "c:c1";
  const first = m.render(cx); // before any read of the switch ends
  assert.ok(strings(first).includes("Gamma page"));
  assert.ok(!strings(first).includes("Loading pages…"));
});

test("a read of an index that is superseded by a newer read of the same session is dropped", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  const job = { key: "local|/s/c1", machine: null, show: { dir: "/s/c1" }, tabId: "c:c1" };
  const path = "/s/c1/pages/pages.json";
  // the old read is held with the old text
  world.files.set(path, index("Old page"));
  world.files.hold(path);
  const old = m.refresh(job, cx);
  await settle(); // the old read has started: it holds the old text
  // a new index is written while the old read is still pending
  world.files.set(path, index("New page"));
  const fresh = m.refresh(job, cx);
  await settle();
  world.files.next(path); // the old read answers now
  assert.equal(await old, false, "the stale result commits nothing");
  assert.equal(m.recs.get("local|/s/c1").pages[0].title, "Gamma page", "the record still holds what it had");
  world.files.next(path); // the new read answers
  assert.equal(await fresh, true);
  await settle();
  assert.equal(m.recs.get("local|/s/c1").pages[0].title, "New page");
});
