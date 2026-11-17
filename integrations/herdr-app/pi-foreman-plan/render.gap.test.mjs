import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../pi-foreman/stubs-hooks.mjs", import.meta.url);
const stubs = await import("../pi-foreman/stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

const sess = (key, hc, dir, parent = "") => ({ key, kind: "session", name: key, hcTerminal: hc, pid: null, parent, state: "working", show: { dir }, children: [] });
const entry = (id, o = {}) => ({ id, kind: id === "plan" ? "plan" : "note", title: id, state: "shown", version: 1, at: "2026-11-06T10:00:00Z", file: `${id}.html`, ...o });
const FILE = "/s/fm/pages/pages.json";
const put = (pages) => world.files.set(FILE, JSON.stringify({ v: 1, pages, events: [] }));

function reset() {
  world.files = new Map();
  put([entry("plan", { state: "draft" }), entry("note-1")]);
  world.reads = []; world.writes = []; world.runCalls = []; world.notices = []; world.layout = null;
  world.shared = { "pi-foreman.radar": { machines: { local: [sess("fm", "t1", "/s/fm")] } } };
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
const rec = (m) => m.recs.get("local|/s/fm");

for (const [name, gap] of [["an unreadable index", () => world.files.delete(FILE)], ["an unparseable index", () => world.files.set(FILE, "{ not json")]]) {
  test(`${name} for one poll keeps the pages and known ids: the same pages after it open nothing`, async () => {
    reset();
    const { m, cx, settle } = boot(); await settle();
    assert.equal(rec(m).pages.length, 2);
    m.tab = "foreman";
    gap();
    m.reload(cx); await settle();
    assert.equal(rec(m).pages.length, 2, "the list does not blank during the gap");
    put([entry("plan", { state: "draft" }), entry("note-1")]);
    m.reload(cx); await settle();
    assert.equal(rec(m).pages.length, 2);
    assert.equal(world.runCalls.length, 0, "no layout.select or layout.show");
    assert.equal(m.tab, "foreman");
  });
}

test("a really new page after a gap still opens the panel", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  world.files.delete(FILE);
  m.reload(cx); await settle();
  assert.equal(world.runCalls.length, 0);
  put([entry("plan", { state: "draft" }), entry("note-1"), entry("note-2")]);
  m.reload(cx); await settle();
  assert.deepEqual(world.runCalls, [["layout.select", { stack: "panel-body", child: "plan" }], ["layout.show", { id: "panel" }]]);
});
