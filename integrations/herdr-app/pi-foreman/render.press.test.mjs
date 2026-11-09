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
  m.machineOf = new Map([[rec.tree[0], "local"]]);
  return m;
};
const walk = (el, out = []) => { if (el && typeof el === "object") { out.push(el); el.kids?.forEach((k) => walk(k, out)); if (el.contentEl) walk(el.contentEl, out); } return out; };
const texts = (el) => walk(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));
const reset = () => {
  world.agents = [{ address: "t1", pane: "p1", space: 1, space_name: "s", status: "idle", program: { name: "pi" } }];
  world.terminals = [{ address: "t1", state: "live" }];
  world.shared = {};
  world.files = new Map();
  world.runCalls = [];
};

test("a click on the header Plan button and a plan row shows a pending state in the render it causes", async () => {
  reset();
  const m = mod(radar({ dir: "/s/fm", plan: 1 }));
  world.files.set("/s/fm/plan.json", JSON.stringify({ v: 1, at: new Date().toISOString() }));
  const cx0 = { spawn: (f) => f(cx0), notify() {}, sleep: () => new Promise(() => {}) };
  m.pollShows(cx0, Date.now());
  await new Promise((r) => setImmediate(r));
  let notified = 0;
  const cx = { notify: () => { notified++; } };
  const find = (prefix) => walk(m.render({})).find((e) => String(e.props?.id ?? "").startsWith(prefix));

  assert.ok(texts(m.render({})).includes("📄 Plan"));
  find("plan-open").props.on_click({}, cx);
  assert.equal(notified, 1, "the click asks for a render");
  assert.ok(texts(m.render({})).includes("📄 Plan …"), "and that render shows the pending state");

  const row = find("show:plan:");
  assert.ok(row);
  const before = row.kids[0];
  assert.ok(!before.endsWith("…"));
  row.props.on_click({}, cx);
  assert.equal(notified, 2);
  assert.ok(find("show:plan:").kids[0].endsWith("…"));
  assert.ok(world.runCalls.length >= 4, "the panel was still brought forward");
});

test("the pending state ends by itself: the 1 s timer drops it after PRESS_MS and redraws", () => {
  reset();
  const m = mod(radar(undefined));
  m.press("plan-open", { notify() {} });
  assert.equal(m.pressing("plan-open"), true);
  let notified = 0;
  m.unpress({ notify: () => notified++ });
  assert.equal(notified, 0, "not yet");
  m.pressed.set("plan-open", Date.now() - 5000);
  assert.equal(m.pressing("plan-open"), false);
  m.unpress({ notify: () => notified++ });
  assert.equal(notified, 1);
  assert.equal(m.pressed.size, 0);
});
