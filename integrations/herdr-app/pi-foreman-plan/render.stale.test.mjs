import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../pi-foreman/stubs-hooks.mjs", import.meta.url);
const stubs = await import("../pi-foreman/stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

const A = "/w/plan-a.md";
const B = "/w/plan-b.md";
const C = "/w/plan-c.md";
const node = (key, hc, show, parent = "") => ({ key, kind: "session", name: key, hcTerminal: hc, pid: null, parent, state: "working", ...(show ? { show } : {}), children: [] });
const meta = (path, o = {}) => JSON.stringify({ path, title: "P", v: 1, at: "2026-11-06T10:00:00Z", hash: "h1", ruledPath: null, prevHash: null, fences: [], ...o });
const NOTE = JSON.stringify({ title: "Why", v: 1, at: "2026-11-06T10:00:00Z", hash: "n1", fences: [] });

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
    ["/s/fm/plan.json", meta(A)], [A, "# Plan A\n\nAlpha body.\n"],
    ["/s/fm/note.json", NOTE], ["/s/fm/note.md", "# Note\n\nnote body\n"],
    ["/s/c1/plan.json", meta(C)], [C, "# Plan C\n\nGamma body.\n"],
    ["/s/dead/plan.json", meta(B)], [B, "# Plan B\n\nBeta body.\n"],
  ]);
  world.reads = []; world.runCalls = []; world.execCalls = [];
  world.shared = {
    "pi-foreman.radar": { machines: { local: [
      node("fm", "t1", { dir: "/s/fm", plan: 1, note: 1 }),
      node("c1", "tc1", { dir: "/s/c1", plan: 1 }, "fm"),
      node("dead", "t9", { dir: "/s/dead", plan: 1 }),
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
const kinds = (el, kind) => walk(el).filter((e) => e.kind === kind);
const mds = (el) => kinds(el, "TextView").map((v) => v.md);
const tabIds = (el) => walk(el).filter((e) => String(e.props?.id ?? "").startsWith("tab-")).map((e) => e.props.id);
let n = 0;
const click = (key) => { world.shared["pi-foreman.show"] = { n: ++n, key, kind: "plan" }; };

test("a switch to a plan already read renders it in the first frame, with no Loading text", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  m.render(cx);
  click("dead"); m.render(cx); await settle(); // read once
  click("fm"); m.render(cx); await settle();
  click("dead");
  const first = m.render(cx);
  assert.ok(mds(first).some((t) => t.includes("Beta body")), "the target is in the first render");
  assert.ok(!strings(first).includes("Loading plan\u2026"));
});

test("an uncached switch keeps the previous body and the same tab labels and header until the next plan is parsed", async () => {
  reset();
  world.files.hold(C);
  const { m, cx, settle } = boot(); await settle();
  const before = m.render(cx);
  const beforeMd = mds(before), beforeTabs = tabIds(before), beforeStrings = strings(before);
  assert.ok(beforeMd.some((t) => t.includes("Alpha body")));
  assert.ok(beforeStrings.includes("Note: Why"), "the Note tab carries the note title");

  click("c1");
  const during = m.render(cx); // c1 is not read yet: its plan is held back
  assert.deepEqual(mds(during), beforeMd, "the body is the previous plan");
  assert.deepEqual(tabIds(during), beforeTabs, "the tab row keeps its tabs");
  assert.ok(strings(during).includes("Note: Why"), "the Note label does not drop to Note");
  assert.ok(strings(during).includes("v1"), "the header version stays");
  assert.ok(!strings(during).includes("Loading plan\u2026"));

  await settle();
  world.files.flush(C); await settle();
  const done = m.render(cx);
  assert.ok(mds(done).some((t) => t.includes("Gamma body")), "once read, the next plan shows");
});

test("background prefetch reads the other tabs after the first paint, so a switch to one needs no read", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  m.render(cx);
  const c1 = m.recs.get("local|/s/c1");
  assert.ok(c1?.ready, "the child tab was read without a click");
  const readsBefore = world.reads.filter(([p]) => p === C).length;
  click("c1");
  const first = m.render(cx);
  assert.ok(mds(first).some((t) => t.includes("Gamma body")));
  assert.equal(world.reads.filter(([p]) => p === C).length, readsBefore, "no document was read for the switch");
});

test("a read of a plan that is superseded by a newer read of the same session is dropped", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  const job = { key: "local|/s/c1", machine: null, show: { dir: "/s/c1" } };
  // the old version: its document read is held with the old text
  world.files.set("/s/c1/plan.json", meta(C, { hash: "h1" }));
  world.files.hold(C);
  const old = m.refresh(job, true, cx);
  await settle(); // the old read has started: it holds the old text
  // a new version starts while the old read is still pending
  world.files.set(C, "# Plan C\n\nNew body.\n");
  world.files.set("/s/c1/plan.json", meta(C, { hash: "h2" }));
  const fresh = m.refresh(job, true, cx);
  await settle();
  world.files.next(C); // the old read answers now
  assert.equal(await old, false, "the stale result commits nothing");
  assert.equal(m.recs.get("local|/s/c1").planDoc.meta.hash, "h1", "the record still holds what it had");
  world.files.next(C); // the new read answers
  assert.equal(await fresh, true);
  await settle();
  assert.equal(m.recs.get("local|/s/c1").planDoc.meta.hash, "h2");
  assert.ok(m.recs.get("local|/s/c1").plan.blocks.some((b) => b.text?.includes("New body")));
});
