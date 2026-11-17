import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../pi-foreman/stubs-hooks.mjs", import.meta.url);
const stubs = await import("../pi-foreman/stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

const index = (...titles) => JSON.stringify({ v: 1, pages: titles.map((title, i) => ({ id: i ? `note-${i}` : "plan", kind: i ? "note" : "plan", title, state: "shown", version: 1, at: `2026-11-06T10:0${i}:00Z`, file: i ? `note-${i}.html` : "plan.html" })), events: [] });
const sess = (key, hc, show, parent = "") => ({ key, kind: "session", name: key, hcTerminal: hc, pid: null, parent, state: "working", ...(show ? { show } : {}), children: [] });
const radar = () => ({ machines: { local: [
  sess("fm", "t1", { dir: "/s/fm" }),
  sess("kid", "tc1", { dir: "/s/n" }, "fm"),
  sess("grand", "tc2", { dir: "/s/g" }, "kid"),
  sess("nodir", "tc3", { plan: 1 }, "fm"),
] } });

// A Map whose read of a path can be held until released, as in render.held.test.mjs.
class Gated extends Map {
  constructor(entries) { super(entries); this.gate = new Map(); }
  hold(path) { this.gate.set(path, []); }
  flush(path) { for (const f of this.gate.get(path) ?? []) f(); this.gate.delete(path); }
  get(path) {
    const v = super.get(path) ?? null;
    const q = this.gate.get(path);
    if (!q) return v;
    return new Promise((r) => q.push(() => r(v)));
  }
}

function reset() {
  world.files = new Gated([
    ["/s/fm/pages/pages.json", index("Root plan")],
    ["/s/n/pages/pages.json", index("Kid plan", "Kid note")],
    ["/s/g/pages/pages.json", index("Grand plan")],
  ]);
  world.reads = []; world.writes = []; world.runCalls = []; world.notices = []; world.layout = null; world.execCalls = [];
  world.shared = { "pi-foreman.radar": radar() };
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
const byId = (el, id) => walk(el).find((e) => e.props?.id === id);

test("children join by the radar parent, nested ones too; a session without a show folder gets no tab", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  const tree = m.render(cx);
  assert.deepEqual(m.cur.tabs.map((t) => t.id), ["foreman", "c:kid", "c:grand"]);
  assert.ok(byId(tree, "tab-c:kid") && byId(tree, "tab-c:grand"));
  assert.equal(byId(tree, "tab-c:nodir"), undefined);
});

test("a child's tab lists all of its pages, newest first, and no switch between plan and note is offered", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  m.render(cx);
  m.tab = "c:kid"; m.render(cx); await settle();
  const tree = m.render(cx);
  const s = strings(tree);
  assert.ok(s.includes("Kid plan") && s.includes("Kid note"));
  assert.ok(s.indexOf("Kid note") < s.indexOf("Kid plan"));
  assert.equal(byId(tree, "part-plan"), undefined);
  assert.ok(!s.includes("Root plan"));
});

test("a click on a child whose read is pending shows Loading, then the child's pages", async () => {
  reset();
  world.files.hold("/s/n/pages/pages.json");
  const { m, cx, settle } = boot(); await settle();
  m.render(cx); await settle();
  assert.ok(!m.recs.get("local|/s/n")?.ready, "the child's read is pending");
  m.tab = "c:kid";
  let tree = m.render(cx);
  assert.ok(strings(tree).includes("Loading pages…"));
  assert.ok(!strings(tree).includes("Kid note"), "the child is not shown before it is read");
  world.files.flush("/s/n/pages/pages.json"); await settle();
  tree = m.render(cx);
  assert.ok(!strings(tree).includes("Loading pages…"), "the indicator goes once the child is ready");
  assert.ok(strings(tree).includes("Kid note"));
});
