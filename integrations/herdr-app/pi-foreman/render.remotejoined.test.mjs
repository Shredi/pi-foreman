import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { attachName, parseRecords } = await import("./model.js");
const { sess, run, treeOf } = await import("./fixtures.mjs");

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

// The local registry child `label@box1` (remote terminal box1/t7) under the local session p (listed as t5), its mirror t3, and the
// remote machine's radar: a node joined to box1/t7 under its own key, with a running worker `scout`.
const reg = () => sess("fm-label-a1b2c3", "label@box1", { machine: "box1", hcTerminal: "box1/t7", state: "working", sym: "working", parent: "p" });
const mirrorName = attachName("box1", "fm-label-a1b2c3");
const spaces = [{ id: 1, machine: null }, { id: 2, machine: "box1" }];
const own = (address = "box1/t7") => ({ address, pane: "p7", space: 2, space_name: "box1 space", status: "done", app: "pi", title: "fm-label-a1b2c3", program: { name: "pi" } });
const remoteTree = (hcTerminal = "t7") => treeOf(sess("rem-label-9f8e7d", "label", { hcTerminal, state: "working", sym: "working" }, [run("r1", "scout", { model: "" })]));
const recsOfBox1 = (...titles) => ({ recs: parseRecords(JSON.stringify({ records: titles.map((t) => ({ app: "pi-subagents", state: "working", title: t, msg: "reading" })) })), attach: "", tried: Date.now() });

function setup({ parentListed = true, listed = own(), remoteHc = "t7", recs = [] } = {}) {
  stubs.world.agents = [...(parentListed ? [{ address: "t5", pane: "p1", space: 1, space_name: "s", status: "idle", program: { name: "pi" } }] : []), listed];
  stubs.world.terminals = [
    { address: "t5", state: "live", foreground: { pid: 7 } },
    { address: "t3", state: "live", name: mirrorName, parent: "t5", argv: ["hc", "attach", "box1/t7"] },
  ];
  stubs.world.spaces = spaces;
  stubs.world.execCalls = [];
  stubs.world.runCalls = [];
  const mod = Object.create(Mod.prototype);
  mod.changed = {}; mod.feed = []; mod.folded = new Set();
  mod.radar = new Map([
    ["local", { ok: true, tree: [treeOf(sess("p", "parent", { pid: 7, hcTerminal: "t5" }, [reg()]))], openPrs: [], tried: Date.now() }],
    ["box1", { ok: true, tree: [remoteTree(remoteHc)], openPrs: [], tried: Date.now() }],
  ]);
  mod.busy = new Map(); mod.recs = new Map(recs); mod.childPi = new Set();
  mod.poll = () => {};
  return mod;
}

test("one remote child is one row under its parent, with the remote node's agents and records once", () => {
  const root = setup({ recs: [["box1/t7", recsOfBox1("scout", "reviewer")]] }).render({});
  assert.equal(count(root, "label@box1"), 1, "the registry row");
  assert.ok(texts(root).indexOf("label@box1") < texts(root).indexOf("scout"), "the agents are under the registry row");
  assert.equal(count(root, "scout"), 1, "the run once: a record of the same title is not drawn again");
  assert.equal(count(root, "reviewer · reading"), 1, "the record that is no run");
  assert.equal(count(root, "label"), 0, "the remote node is drawn nowhere else");
});

test("no top-level row or group header for the joined remote terminal", () => {
  const root = setup().render({});
  assert.equal(byId(root, "sp-2").length, 0, "no group of the remote machine's space");
  assert.equal(byId(root, "agent:box1/t7").length, 0, "no row of the remote terminal");
  assert.equal(count(root, "label@box1"), 1);
});

test("the same rows without the mirror terminal (before any click)", () => {
  const mod = setup();
  stubs.world.terminals = [{ address: "t5", state: "live", foreground: { pid: 7 } }];
  const root = mod.render({});
  assert.equal(count(root, "label@box1"), 1);
  assert.equal(byId(root, "sp-2").length, 0);
});

test("a joined remote terminal whose registry node is not drawn keeps its row and group", () => {
  const root = setup({ parentListed: false, recs: [["box1/t7", recsOfBox1("scout")]] }).render({});
  assert.equal(count(root, "label@box1"), 0, "the registry node is not drawn");
  assert.equal(byId(root, "sp-2").length, 1, "its group");
  assert.ok(byId(root, "agent:box1/t7").length > 0, "its row");
  assert.equal(count(root, "scout"), 1, "its own agents");
});

test("a joined remote terminal that matches no local registry node keeps its own row and group", () => {
  const root = setup({ listed: own("box1/t9"), remoteHc: "t9", recs: [["box1/t9", recsOfBox1("scout")]] }).render({});
  assert.equal(count(root, "label@box1"), 1, "the registry row, its remote terminal box1/t7 is not listed");
  assert.equal(byId(root, "sp-2").length, 1);
  assert.ok(byId(root, "agent:box1/t9").length > 0);
  assert.equal(count(root, "scout"), 1);
});
