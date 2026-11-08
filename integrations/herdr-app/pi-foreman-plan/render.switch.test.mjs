import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../pi-foreman/stubs-hooks.mjs", import.meta.url);
const stubs = await import("../pi-foreman/stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

const DOC_A = "/w/plan-a.md";
const DOC_B = "/w/plan-b.md";
const node = (key, hc, show, parent = "") => ({ key, kind: "session", name: key, hcTerminal: hc, pid: null, parent, state: "working", ...(show ? { show } : {}), children: [] });
const meta = (path, o = {}) => JSON.stringify({ path, title: "P", v: 1, at: "2026-11-06T10:00:00Z", hash: "h", ruledPath: null, prevHash: null, fences: [], ...o });
const FENCED = "# Plan\n\nText.\n\n```js\nconst x = 1;\n```\n\nAfter.\n";

function reset() {
  world.files = new Map([
    ["/s/fm/plan.json", meta(DOC_A)], [DOC_A, FENCED],
    ["/s/dead/plan.json", meta(DOC_B)], [DOC_B, "# Other\n\nbody\n"],
  ]);
  world.reads = []; world.runCalls = [];
  world.shared = { "pi-foreman.radar": { machines: { local: [node("fm", "t1", { dir: "/s/fm", plan: 1 }), node("dead", "t9", { dir: "/s/dead", plan: 1 })] } } };
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

test("a sidebar click is followed by the next render, not the 1 s timer; the previous plan stays until the next is read", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  assert.equal(m.cur.root.key, "fm");
  m.render(cx); // the frame that was on screen before the click
  world.shared["pi-foreman.show"] = { n: Date.now(), key: "dead", kind: "plan" }; // the click
  const tree = m.render(cx); // no tick in between
  assert.equal(m.cur.root.key, "dead", "this render already switched");
  assert.ok(!strings(tree).includes("Loading plan…"), "and does not blank the body to Loading while the previous plan is on screen");
  assert.ok(!kinds(tree, "TextView").some((v) => v.md === "body"), "the next plan is not shown before it is read");
  await settle();
  const done = m.render(cx);
  assert.ok(kinds(done, "TextView").some((v) => v.md === "body"));
  assert.ok(!strings(done).includes("Loading plan…"));
});

test("the first paint is the plain markdown; the editor of a code fence follows once decorating is done", async () => {
  reset();
  const gate = {};
  const hold = new Promise((r) => { gate.go = r; });
  const real = Mod.prototype.decorate;
  Mod.prototype.decorate = async function (...a) { await hold; return real.apply(this, a); };
  try {
    const { m, cx, settle } = boot(); await settle();
    const first = m.render(cx);
    assert.ok(kinds(first, "TextView").some((v) => v.md.includes("const x = 1;")), "the fence is drawn as markdown text");
    assert.equal(kinds(first, "Editor").length, 0);
    assert.ok(cx.notified >= 1, "and a notify asked for that paint before decorating ended");
    gate.go(); await settle();
    assert.equal(kinds(m.render(cx), "Editor").length, 1);
  } finally { Mod.prototype.decorate = real; }
});

test("a parsed document is cached per path and content: the same text is not parsed again, changed text is", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  const rec = m.recs.get("local|/s/fm");
  const doc = rec.plan;
  // a new version over the same text: plan.json bytes change, the document does not
  world.files.set("/s/fm/plan.json", meta(DOC_A, { v: 2 }));
  m.reload(cx); await settle();
  assert.equal(rec.plan, doc, "same path + hash: the parsed document is reused");
  assert.equal(rec.planDoc.meta.v, 2);
  world.files.set("/s/fm/plan.json", meta(DOC_A, { v: 3 }));
  world.files.set(DOC_A, FENCED + "\nMore.\n");
  m.reload(cx); await settle();
  assert.notEqual(rec.plan, doc, "changed hash: parsed again");
  assert.ok(rec.plan.blocks.length > doc.blocks.length - 1);
  assert.ok(m.parsed.size >= 2);
});

test("the parsed-document cache belongs to its copy", async () => {
  reset();
  const a = boot(); await a.settle();
  const b = boot(); await b.settle();
  assert.notEqual(a.m.parsed, b.m.parsed);
});
