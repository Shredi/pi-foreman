import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { parseRadarDoc, buildTree } = await import("./model.js");
const { sess } = await import("./fixtures.mjs");
const { world } = stubs;

const radar = (show) => {
  const doc = parseRadarDoc(JSON.stringify({ v: 1, roots: [sess("fm", "foreman", { hcTerminal: "t1", show })] }));
  return { ok: true, tree: buildTree(doc.nodes), nodes: doc.nodes, openPrs: [], tried: Date.now() };
};
const mod = (rec) => {
  const m = Object.create(Mod.prototype);
  m.changed = {}; m.feed = []; m.folded = new Set(); m.busy = new Map(); m.recs = new Map(); m.childPi = new Set();
  m.radar = new Map([["local", rec]]);
  m.poll = () => {};
  return m;
};
const walk = (el, out = []) => { if (el && typeof el === "object") { out.push(el); el.kids?.forEach((k) => walk(k, out)); if (el.contentEl) walk(el.contentEl, out); } return out; };
const texts = (el) => walk(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));
const reset = () => {
  world.agents = [{ address: "t1", pane: "p1", space: 1, space_name: "s", status: "idle", program: { name: "pi" } }];
  world.terminals = [{ address: "t1", state: "live" }];
  world.shared = {};
  world.files = new Map();
  world.reads = [];
};

test("the parsed radar is published for the plan panel, and only again when the sessions changed", () => {
  reset();
  const m = mod(radar({ dir: "/s/fm", plan: 1 }));
  m.publish();
  const first = world.shared["pi-foreman.radar"];
  assert.deepEqual(Object.keys(first.machines), ["local"]);
  assert.equal(first.machines.local[0].show.plan, 1);
  m.publish();
  assert.equal(world.shared["pi-foreman.radar"], first, "same content: no second write");
  m.radar.set("local", radar({ dir: "/s/fm", plan: 2 }));
  m.publish();
  assert.notEqual(world.shared["pi-foreman.radar"], first);
  assert.equal(world.shared["pi-foreman.radar"].machines.local[0].show.plan, 2);
  m.radar.set("local", { ok: false, tried: 0 });
  m.publish();
  assert.deepEqual(world.shared["pi-foreman.radar"].machines, {}, "a machine without radar leaves the published set");
});

test("a session with a plan and a note gets a row for each, with the age, and no row without a pointer", async () => {
  reset();
  const m = mod(radar({ dir: "/s/fm", plan: 3, note: 1 }));
  world.files.set("/s/fm/plan.json", JSON.stringify({ v: 3, at: new Date(Date.now() - 4 * 60000).toISOString() }));
  world.files.set("/s/fm/note.json", JSON.stringify({ v: 1, at: new Date(Date.now() - 60000).toISOString() }));
  const cx = { spawn: (f) => f(cx), notify() {}, sleep: () => new Promise(() => {}) };
  m.pollShows(cx, Date.now());
  await new Promise((r) => setImmediate(r));
  m.machineOf = new Map([[m.radar.get("local").tree[0], "local"]]);
  const t = texts(m.render({}));
  assert.ok(t.includes("📄 plan v3 · 4m") && t.includes("📝 note · 1m"), t.join("|"));
  const plain = mod(radar(undefined));
  assert.ok(!texts(plain.render({})).some((x) => x.startsWith("📄 plan") || x.startsWith("📝")));
});

test("show files are re-read when the version hint moves or after 30 s, not on every poll", async () => {
  reset();
  const m = mod(radar({ dir: "/s/fm", plan: 1 }));
  const cx = { spawn: (f) => f(cx), notify() {}, sleep: () => new Promise(() => {}) };
  const reads = () => world.reads.filter(([p]) => p === "/s/fm/plan.json").length;
  m.pollShows(cx, 1000); await new Promise((r) => setImmediate(r));
  m.pollShows(cx, 5000); await new Promise((r) => setImmediate(r));
  assert.equal(reads(), 1);
  m.radar.set("local", radar({ dir: "/s/fm", plan: 2 }));
  m.pollShows(cx, 6000); await new Promise((r) => setImmediate(r));
  assert.equal(reads(), 2, "hint moved");
  m.pollShows(cx, Date.now() + 40000); await new Promise((r) => setImmediate(r));
  assert.equal(reads(), 3, "older than 30 s");
});

test("the header Plan button brings the panel forward without pinning anything", () => {
  reset();
  const m = mod(radar(undefined));
  const btn = walk(m.render({})).find((e) => e.props?.id === "plan-open");
  assert.ok(btn);
  world.runCalls = [];
  btn.props.on_click();
  assert.deepEqual(world.runCalls, [["layout.select", { stack: "panel-body", child: "plan" }], ["layout.show", { id: "panel" }]]);
  assert.equal(world.shared["pi-foreman.show"], undefined);
});

test("a click on a plan row pins the session and document and asks the layout for the panel", () => {
  reset();
  const m = mod(radar({ dir: "/s/fm", plan: 1 }));
  world.runCalls = [];
  const node = m.radar.get("local").tree[0];
  m.openPanel(node, "note");
  const pin = world.shared["pi-foreman.show"];
  assert.deepEqual([pin.key, pin.kind, Number.isInteger(pin.n)], ["fm", "note", true]);
  assert.deepEqual(world.runCalls, [["layout.select", { stack: "panel-body", child: "plan" }], ["layout.show", { id: "panel" }]]);
});
