import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { attachName } = await import("./model.js");
const { sess, treeOf } = await import("./fixtures.mjs");

const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.contentEl) walk(el.contentEl, out);
  return out;
};
const byId = (root, prefix) => walk(root).filter((e) => String(e.props.id ?? "").startsWith(prefix));
const texts = (el) => walk(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));
const count = (root, text) => texts(root).filter((x) => x === text).length;

// One remote child: registry row `label@box1` under the local session p (agent t5), the local mirror terminal t3 (parent t5) and
// the remote machine's own terminal box1/t7 in a space of box1.
const reg = () => sess("fm-label-a1b2c3", "label@box1", { machine: "box1", hcTerminal: "box1/t7", state: "working", sym: "working", parent: "p" });
const mirrorName = attachName("box1", "fm-label-a1b2c3");
const spaces = [{ id: 1, machine: null }, { id: 2, machine: "box1" }];
const own = { address: "box1/t7", pane: "p7", space: 2, space_name: "box1 space", status: "done", app: "pi", title: "fm-label-a1b2c3", program: { name: "pi" } };

function render({ mirror = true, listedOwn = true, argv = true, recs = null, name = mirrorName, extraTerms = [] } = {}) {
  stubs.world.agents = [{ address: "t5", pane: "p1", space: 1, space_name: "s", status: "idle", program: { name: "pi" } }, ...(listedOwn ? [own] : [])];
  stubs.world.terminals = [
    { address: "t5", state: "live", foreground: { pid: 7 } },
    ...(mirror ? [{ address: "t3", state: "live", name, parent: "t5", ...(argv ? { argv: ["hc", "attach", "box1/t7"] } : {}) }] : []),
    ...extraTerms,
  ];
  stubs.world.spaces = spaces;
  stubs.world.execCalls = [];
  stubs.world.runCalls = [];
  const mod = Object.create(Mod.prototype);
  mod.changed = {}; mod.feed = []; mod.folded = new Set();
  mod.radar = new Map([["local", { ok: true, tree: [treeOf(sess("p", "parent", { pid: 7, hcTerminal: "t5" }, [reg()]))], openPrs: [], tried: Date.now() }], ["box1", { ok: false, tried: Date.now() }]]);
  mod.busy = new Map(); mod.recs = new Map(recs ?? []); mod.childPi = new Set();
  mod.poll = () => {};
  return { mod, root: mod.render({}) };
}

test("one remote child is one row: the registry row, no mirror row, no row or group of the remote terminal", () => {
  const { root } = render();
  assert.equal(count(root, "label@box1"), 1, "the registry row");
  assert.ok(!texts(root).includes(mirrorName), "no row of the mirror");
  assert.ok(!byId(root, "hc:t3").length);
  assert.equal(byId(root, "sp-2").length, 0, "no group of the remote machine's space");
  assert.ok(!byId(root, "agent:box1/t7").length, "no row of the remote terminal");
});

test("the mirror is recognised by its name when its record has no argv", () => {
  const { root } = render({ argv: false });
  assert.equal(count(root, "label@box1"), 1);
  assert.ok(!texts(root).includes(mirrorName));
});

test("no mirror terminal (before any click): still the registry row alone", () => {
  const { root } = render({ mirror: false });
  assert.equal(count(root, "label@box1"), 1);
  assert.equal(byId(root, "sp-2").length, 0);
});

test("a remote terminal that matches no local registry node keeps its group and row", () => {
  stubs.world.agents = [{ address: "t5", pane: "p1", space: 1, space_name: "s", status: "idle", program: { name: "pi" } }, { ...own, address: "box1/t9" }];
  stubs.world.terminals = [{ address: "t5", state: "live", foreground: { pid: 7 } }];
  stubs.world.spaces = spaces;
  const mod = Object.create(Mod.prototype);
  mod.changed = {}; mod.feed = []; mod.folded = new Set();
  mod.radar = new Map([["local", { ok: true, tree: [treeOf(sess("p", "parent", { pid: 7, hcTerminal: "t5" }, [reg()]))], openPrs: [], tried: Date.now() }], ["box1", { ok: false, tried: Date.now() }]]);
  mod.busy = new Map(); mod.recs = new Map(); mod.childPi = new Set();
  mod.poll = () => {};
  const root = mod.render({});
  assert.equal(byId(root, "sp-2").length, 1);
  assert.ok(byId(root, "agent:box1/t9").length > 0);
});

test("a named terminal with an unknown attach target keeps its row", () => {
  const { root } = render({ name: "build", argv: false, listedOwn: false });
  assert.ok(texts(root).includes("build"));
});
