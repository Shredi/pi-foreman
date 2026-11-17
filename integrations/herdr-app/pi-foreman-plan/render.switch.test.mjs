import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../pi-foreman/stubs-hooks.mjs", import.meta.url);
const stubs = await import("../pi-foreman/stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

const node = (key, hc, show, parent = "") => ({ key, kind: "session", name: key, hcTerminal: hc, pid: null, parent, state: "working", ...(show ? { show } : {}), children: [] });
const index = (title) => JSON.stringify({ v: 1, pages: [{ id: "plan", kind: "plan", title, state: "draft", version: 1, at: "2026-11-06T10:00:00Z", file: "plan.html" }], events: [] });

function reset() {
  world.files = new Map([["/s/fm/pages/pages.json", index("Own page")], ["/s/dead/pages/pages.json", index("Other page")]]);
  world.reads = []; world.runCalls = [];
  world.shared = { "pi-foreman.radar": { machines: { local: [node("fm", "t1", { dir: "/s/fm" }), node("dead", "t9", { dir: "/s/dead" })] } } };
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

test("a sidebar click is followed by the next render, not the 1 s timer; the list shows once the session is read", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  assert.equal(m.cur.root.key, "fm");
  m.render(cx); // the frame that was on screen before the click
  world.shared["pi-foreman.show"] = { n: Date.now(), key: "dead", kind: "plan" }; // the click
  const tree = m.render(cx); // no tick in between
  assert.equal(m.cur.root.key, "dead", "this render already switched");
  assert.ok(!strings(tree).includes("Other page"), "the next list is not shown before it is read");
  await settle();
  const done = m.render(cx);
  assert.ok(strings(done).includes("Other page"));
  assert.ok(!strings(done).includes("Loading pages…"));
});

test("two copies of the panel keep their own records and slot counter", async () => {
  reset();
  const a = boot(); await a.settle();
  const b = boot(); await b.settle();
  assert.notEqual(a.m.recs, b.m.recs);
  a.m.slot = 5;
  assert.equal(b.m.slot, 0);
});
