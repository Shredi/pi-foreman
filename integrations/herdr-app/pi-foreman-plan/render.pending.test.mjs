import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../pi-foreman/stubs-hooks.mjs", import.meta.url);
const stubs = await import("../pi-foreman/stubs.mjs");
const { default: Mod } = await import("./main.js");
const { default: Sidebar } = await import("../pi-foreman/main.js");
const { world } = stubs;

const sess = (key, show) => ({ key, kind: "session", name: key, hcTerminal: key === "fm" ? "t1" : "t9", pid: null, parent: "", state: "working", show, children: [] });

function reset() {
  world.files = new Map(); world.reads = []; world.writes = []; world.runCalls = []; world.notices = []; world.layout = null;
  world.shared = { "pi-foreman.radar": { machines: { local: [sess("fm", { dir: "/s/fm", plan: 1 }), sess("dead", { dir: "/s/dead", plan: 1 })] } } };
  world.agents = [{ address: "t1", tab: "tabA", pane: "p1" }];
  world.panes = [{ pane: "p1", tab: "tabA", terminal: "t1" }];
  world.terminals = [];
  world.focus = { space: "s", tab: "tabA", pane: "p1", terminal: "t1", shown: null, agent: "t1", cwd: null };
}
const cxOf = () => { const cx = { spawn(f) { f(cx); }, notify() {}, timer: { every() {} }, sleep: () => new Promise(() => {}) }; return cx; };
const mount = () => { const m = Object.create(Mod.prototype); m.init({}, cxOf()); return m; };
const click = (key, kind = "plan") => {
  const s = Object.create(Sidebar.prototype);
  s.openPanel({ key }, kind);
};

test("the sidebar leaves its open request in shared state next to the pin", () => {
  reset();
  click("dead");
  assert.equal(world.shared["pi-foreman.show"].key, "dead");
  assert.deepEqual(world.shared["pi-foreman.show-pending"], world.shared["pi-foreman.show"]);
});

test("a click while the panel is closed: the plan mod mounted later opens that plan, exactly once", () => {
  reset();
  click("dead"); // nothing mounted: the change was seen by nobody
  const m = mount();
  assert.equal(m.cur.root.key, "dead", "the pending request is applied by the first sync");
  assert.equal(world.shared["pi-foreman.show-pending"], null, "and consumed");
  // a re-render / next tick does not apply it again: the user moves on to the tab's own session, nothing pulls the pin back
  m.pin = null; m.sync(); m.sync();
  assert.equal(m.cur.root.key, "fm");
  // a copy mounted again later (the panel closed and opened by hand) finds the pin but no pending request: not applied
  const again = mount();
  assert.equal(again.cur.root.key, "fm");
});

test("a click while the panel is open still applies through the change, and clears the pending request", () => {
  reset();
  const m = mount();
  assert.equal(m.cur.root.key, "fm");
  click("dead");
  m.sync();
  assert.equal(m.cur.root.key, "dead");
  assert.equal(world.shared["pi-foreman.show-pending"], null);
  assert.equal(mount().cur.root.key, "fm", "a later mount does not replay it");
});

test("a click on a note row while closed opens the Note tab", () => {
  reset();
  world.shared["pi-foreman.radar"].machines.local[0].show = { dir: "/s/fm", plan: 1, note: 2 };
  click("fm", "note");
  const m = mount();
  assert.equal(m.tab, "note");
});
