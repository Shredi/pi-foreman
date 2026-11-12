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

// Local registry child `label@box1` (remote terminal box1/t7) under the local session p (listed as t5); the remote machine's
// radar is not ok (not joined), its own terminal box1/t7 is listed.
const reg = () => sess("fm-label-a1b2c3", "label@box1", { machine: "box1", hcTerminal: "box1/t7", state: "working", sym: "working", parent: "p" });
const own = { address: "box1/t7", pane: "p7", space: 2, space_name: "box1 space", status: "done", app: "pi", title: "fm-label-a1b2c3", program: { name: "pi" } };

function setup({ parentListed }) {
  stubs.world.agents = [...(parentListed ? [{ address: "t5", pane: "p1", space: 1, space_name: "s", status: "idle", program: { name: "pi" } }] : []), own];
  stubs.world.terminals = [
    { address: "t5", state: "live", foreground: { pid: 7 } },
    { address: "t3", state: "live", name: attachName("box1", "fm-label-a1b2c3"), parent: "t5", argv: ["hc", "attach", "box1/t7"] },
  ];
  stubs.world.spaces = [{ id: 1, machine: null }, { id: 2, machine: "box1" }];
  stubs.world.execCalls = [];
  stubs.world.runCalls = [];
  const mod = Object.create(Mod.prototype);
  mod.changed = {}; mod.feed = []; mod.folded = new Set();
  mod.radar = new Map([
    ["local", { ok: true, tree: [treeOf(sess("p", "parent", { pid: 7, hcTerminal: "t5" }, [reg()]))], openPrs: [], tried: Date.now() }],
    ["box1", { ok: false, tree: [], openPrs: [], tried: Date.now() }],
  ]);
  mod.busy = new Map(); mod.recs = new Map(); mod.childPi = new Set();
  mod.poll = () => {};
  return mod;
}

test("unjoined remote terminal whose registry row is not drawn keeps its row and group", () => {
  const root = setup({ parentListed: false }).render({});
  assert.equal(count(root, "label@box1"), 0, "the registry row is not drawn");
  assert.equal(byId(root, "sp-2").length, 1, "its group");
  assert.ok(byId(root, "agent:box1/t7").length > 0, "its row");
});

test("unjoined remote terminal whose registry row is drawn has no row or group", () => {
  const root = setup({ parentListed: true }).render({});
  assert.equal(count(root, "label@box1"), 1, "the registry row");
  assert.equal(byId(root, "sp-2").length, 0, "no group");
  assert.equal(byId(root, "agent:box1/t7").length, 0, "no row");
});
