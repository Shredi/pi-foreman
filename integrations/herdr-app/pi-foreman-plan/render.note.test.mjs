import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../pi-foreman/stubs-hooks.mjs", import.meta.url);
const stubs = await import("../pi-foreman/stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

const sess = (key, hc, dir, parent = "") => ({ key, kind: "session", name: key, hcTerminal: hc, pid: null, parent, state: "working", show: { dir }, children: [] });
const entry = (id, o = {}) => ({ id, kind: id === "plan" ? "plan" : "note", title: id, state: "shown", version: 1, at: "2026-11-06T10:00:00Z", file: `${id}.html`, ...o });
const put = (dir, pages) => world.files.set(`${dir}/pages/pages.json`, JSON.stringify({ v: 1, pages, events: [] }));

function reset() {
  world.files = new Map();
  put("/s/fm", [entry("plan", { state: "draft" })]);
  put("/s/c1", [entry("note-1")]);
  world.reads = []; world.writes = []; world.runCalls = []; world.notices = []; world.layout = null;
  world.shared = { "pi-foreman.radar": { machines: { local: [sess("fm", "t1", "/s/fm"), sess("c1", "tc1", "/s/c1", "fm")] } } };
  world.agents = [{ address: "t1", tab: "tabA", pane: "p1" }];
  world.panes = [{ pane: "p1", tab: "tabA", terminal: "t1" }];
  world.terminals = [];
  world.focus = { space: "s", tab: "tabA", pane: "p1", terminal: "t1", shown: null, agent: "t1", cwd: null };
}

function boot() {
  const cx = { notified: 0, spawn(f) { f(cx); }, notify() { cx.notified++; }, timer: { every() {} }, sleep: () => new Promise(() => {}) };
  const m = Object.create(Mod.prototype);
  m.init({}, cx);
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  return { m, cx, settle };
}
const SHOW = [["layout.select", { stack: "panel-body", child: "plan" }], ["layout.show", { id: "panel" }]];

test("a new page opens the panel on the foreman's tab; the first sight, an unchanged index and a state change do not", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  m.tab = "c:c1";
  m.tick(cx); await settle();
  assert.equal(world.runCalls.length, 0, "the first sight records only");
  put("/s/fm", [entry("plan", { state: "waits for you" })]);
  m.tick(cx); m.reload(cx); await settle();
  assert.equal(world.runCalls.length, 0, "a new state of a known page opens nothing");
  assert.equal(m.tab, "c:c1");
  put("/s/fm", [entry("plan", { state: "waits for you" }), entry("note-2")]);
  m.reload(cx); await settle();
  assert.equal(m.tab, "foreman");
  assert.deepEqual(world.runCalls, SHOW);
  m.reload(cx); await settle();
  assert.equal(world.runCalls.length, 2, "an unchanged index does not open it again");
});

test("a higher plan version is a new page", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  put("/s/fm", [entry("plan", { version: 2 })]);
  m.reload(cx); await settle();
  assert.deepEqual(world.runCalls, SHOW);
});

test("a page that arrives in a child opens the panel on the child's tab; the first sight of the child does not", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  m.tick(cx); await settle();
  assert.equal(world.runCalls.length, 0);
  assert.notEqual(m.tab, "c:c1");
  put("/s/c1", [entry("note-1"), entry("result", { kind: "result" })]);
  m.reload(cx); await settle(); // the poll of the children follows each read of the tab's own session
  assert.equal(m.tab, "c:c1");
  assert.deepEqual(world.runCalls, SHOW);
});

test("the ids come from the shown layout when it has the block", async () => {
  reset();
  world.layout = { id: "root", type: "column", children: [{ id: "side", type: "column", hidden: true, children: [{ id: "tabs", type: "stack", children: [{ id: "pp", type: "block", content: { mod: "pi-foreman-plan" } }] }] }] };
  const { m, cx, settle } = boot(); await settle();
  m.tick(cx);
  put("/s/fm", [entry("plan", { state: "draft" }), entry("note-2")]);
  m.reload(cx); await settle();
  assert.deepEqual(world.runCalls, [["layout.select", { stack: "tabs", child: "pp" }], ["layout.show", { id: "side" }]]);
});
