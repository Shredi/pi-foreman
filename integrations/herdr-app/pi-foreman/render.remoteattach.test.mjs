import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
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
const spinners = (root) => walk(root).filter((e) => e.kind === "svg" && /spinner/.test(e.src ?? ""));

// One remote child `label@box1` under the local session p (agent t5). Its registry entry stored the local attach terminal's address `t3`
// (radar's `attach`); that terminal has a name and an argv that match nothing, and reports `working` while the remote child is `over.state`.
const reg = (over = {}) => sess("fm-label-a1b2c3", "label@box1", { machine: "box1", hcTerminal: "box1/t7", state: "blocked", sym: "blocked", parent: "p", attach: "t3", ...over });
const agent = (address, over = {}) => ({ address, pane: `p-${address}`, space: 1, space_name: "s", status: "idle", program: { name: "pi" }, ...over });

function render({ nodeOver = {}, agents = [agent("t5")], terminals = [], termOver = {} } = {}) {
  stubs.world.agents = agents;
  stubs.world.terminals = [
    { address: "t5", state: "live", foreground: { pid: 7 } },
    { address: "t3", state: "live", name: "wrapped", parent: "t5", status: "working", argv: ["sh", "-c", 'exec "$HC" attach box1/t7'], ...termOver },
    ...terminals,
  ];
  stubs.world.spaces = [{ id: 1, machine: null }];
  stubs.world.execCalls = [];
  stubs.world.runCalls = [];
  const mod = Object.create(Mod.prototype);
  mod.changed = {}; mod.feed = []; mod.folded = new Set();
  mod.radar = new Map([["local", { ok: true, tree: [treeOf(sess("p", "parent", { pid: 7, hcTerminal: "t5" }, [reg(nodeOver)]))], openPrs: [], tried: Date.now() }]]);
  mod.busy = new Map(); mod.recs = new Map(); mod.childPi = new Set();
  mod.poll = () => {};
  return mod.render({});
}

test("a remote child whose local attach reports working while the node is blocked is one row, with no spinner (Needs you)", () => {
  const root = render();
  assert.equal(count(root, "label@box1"), 1, "the registry row only");
  assert.ok(!texts(root).includes("wrapped"), "no row of the attach terminal");
  assert.equal(byId(root, "hc:t3").length, 0);
  assert.equal(spinners(root).length, 0, "no spinner: the attach's own working status is not shown");
  assert.equal(count(root, "Needs you"), 1, "the child's pill");
});

test("the card's status is the node's, so a working child spins and a blocked one does not", () => {
  assert.equal(spinners(render({ nodeOver: { state: "working", sym: "working" } })).length, 1);
  assert.equal(spinners(render()).length, 0);
});

test("a listed agent with a pane at the stored address, whose parent is not listed, is no row of its own", () => {
  const root = render({
    agents: [agent("t5"), agent("t3", { status: "working", title: "wrapped" })],
    terminals: [],
    termOver: { parent: "t99" },
  });
  assert.equal(byId(root, "agent:t3").length, 0, "no top-level row for the attach terminal");
  assert.equal(count(root, "label@box1"), 1, "the card stays");
});

test("a malformed attach address hides nothing", () => {
  const root = render({ nodeOver: { attach: "t3 x" } });
  assert.ok(texts(root).includes("wrapped"), "the terminal keeps its row");
});
