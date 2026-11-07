import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../pi-foreman/stubs-hooks.mjs", import.meta.url);
const stubs = await import("../pi-foreman/stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

const sess = (key, show) => ({ key, kind: "session", name: key, hcTerminal: key === "fm" ? "t1" : "t9", pid: null, parent: "", state: "working", show, children: [] });
const OWN = sess("fm", { dir: "/s/fm", plan: 1, note: 3 });
const DEAD = sess("dead", { dir: "/s/dead", plan: 1 });

function reset(pin) {
  world.files = new Map(); world.reads = []; world.writes = []; world.runCalls = []; world.notices = []; world.layout = null;
  world.shared = { "pi-foreman.radar": { machines: { local: [OWN, DEAD] } } };
  if (pin) world.shared["pi-foreman.show"] = pin;
  world.agents = [{ address: "t1", tab: "tabA", pane: "p1" }];
  world.panes = [{ pane: "p1", tab: "tabA", terminal: "t1" }];
  world.terminals = [];
  world.focus = { space: "s", tab: "tabA", pane: "p1", terminal: "t1", shown: null, agent: "t1", cwd: null };
}
function boot() {
  const cx = { notified: 0, spawn(f) { f(cx); }, notify() { cx.notified++; }, timer: { every() {} }, sleep: () => new Promise(() => {}) };
  const m = Object.create(Mod.prototype);
  m.init({}, cx);
  return m;
}
const setPin = (n) => { world.shared["pi-foreman.show"] = { n, key: "dead", kind: "plan" }; };

test("a pin present before the first sync is ignored: own session, Note tab present", () => {
  reset({ n: 5, key: "dead", kind: "plan" });
  const m = boot(); m.sync();
  assert.equal(m.cur.root.key, "fm");
  assert.deepEqual(m.cur.tabs.map((t) => t.id), ["plan", "note"]);
});

test("a pin whose n changes after the first sync is applied", () => {
  reset({ n: 5, key: "dead", kind: "plan" });
  const m = boot(); m.sync();
  setPin(6); m.sync();
  assert.equal(m.cur.root.key, "dead");
});

test("the same n seen again is not re-applied", () => {
  reset({ n: 5, key: "dead", kind: "plan" });
  const m = boot(); m.sync();
  setPin(6); m.sync();
  m.pin = null; m.sync();
  assert.equal(m.cur.root.key, "fm");
});
