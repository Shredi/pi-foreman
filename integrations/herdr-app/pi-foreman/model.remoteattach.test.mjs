import test from "node:test";
import assert from "node:assert/strict";
import { hcChildItems, remoteNodesOf, endedRemoteNodesOf, remoteClick, parseRadarDoc } from "./model.js";
import { sess, treeOf } from "./fixtures.mjs";

// A remote child whose registry entry stored the address of its local attach terminal: radar sends it as `attach`.
const regNode = (over = {}) => sess("fm-label-a1b2c3", "label@box1", { machine: "box1", hcTerminal: "box1/t7", state: "working", sym: "working", parent: "p", attach: "t3", ...over });
const tree = (kid = regNode()) => treeOf(sess("p", "parent", { hcTerminal: "t1" }, [kid]));
// the attach terminal under another name and a wrapper argv: neither the name nor the argv match
const odd = (over = {}) => ({ address: "t3", state: "live", name: "wrapped", parent: "t1", argv: ["sh", "-c", 'exec "$HC" attach box1/t7'], ...over });
const terms = (over) => [{ address: "t1", state: "live", name: "parent" }, odd(over)];
const draw = (all, root = tree(), extra = {}) => {
  const nodes = remoteNodesOf([root]);
  const resolve = () => ({ node: null, recs: [], own: "working", status: "working" });
  return hcChildItems(all, "t1", resolve, { drawnTargets: new Set(nodes.map((x) => x.target)), remoteNodes: nodes, endedNodes: endedRemoteNodesOf([root]), ...extra });
};
const addrs = (items) => items.flatMap((i) => [i.address, ...addrs(i.children)]).filter(Boolean);

test("parseRadarDoc keeps the attach address of a node as a string, and gives none an empty one", () => {
  const raw = (over) => JSON.stringify({ v: 1, roots: [{ key: "a", kind: "session", name: "a", state: "working", machine: "box1", hcTerminal: "t7", ...over }] });
  assert.equal(parseRadarDoc(raw({ attach: "t71" })).nodes[0].attach, "t71");
  assert.equal(parseRadarDoc(raw({})).nodes[0].attach, "");
  assert.equal(parseRadarDoc(raw({ attach: 7 })).nodes[0].attach, "");
});

test("remoteNodesOf and endedRemoteNodesOf carry a well-formed attach address and leave a malformed one out", () => {
  assert.equal(remoteNodesOf([tree()])[0].attach, "t3");
  assert.equal(remoteNodesOf([tree(regNode({ attach: "local/t3" }))])[0].attach, "local/t3");
  for (const bad of ["", "a b", "../x", "t3;rm", "-", "a/b/c"]) assert.ok(!("attach" in remoteNodesOf([tree(regNode({ attach: bad }))])[0]), `"${bad}" is dropped`);
  assert.equal(endedRemoteNodesOf([tree(regNode({ state: "closed", sym: "closed", ended_s: 600 }))])[0].attach, "t3");
});

test("the terminal at the stored attach address is no row, whatever its name and argv; its children stay", () => {
  assert.deepEqual(addrs(draw(terms())), []);
  assert.deepEqual(addrs(draw([...terms(), { address: "t4", state: "live", name: "shell", parent: "t3" }])), ["t4"]);
});

test("a terminal at another address keeps its row, and a malformed attach address hides nothing", () => {
  assert.deepEqual(addrs(draw(terms({ address: "t9" }))), ["t9"]);
  assert.deepEqual(addrs(draw(terms(), tree(regNode({ attach: "t3 x" })))), ["t3"]);
  assert.deepEqual(addrs(draw(terms(), tree(regNode({ attach: "" })))), ["t3"]);
});

test("the exact address also names the ended mirror of an ended remote session", () => {
  const ended = tree(regNode({ state: "closed", sym: "closed", ended_s: 600 }));
  const items = draw(terms(), ended);
  assert.deepEqual(items.map((i) => [i.address, i.ended]), [["t3", "box1/t7"]]);
});

test("a click on the card focuses the terminal at the stored address, whatever its argv, else opens one", () => {
  const node = tree().children[0];
  assert.deepEqual(remoteClick(node, terms()), { kind: "focus", address: "t3" });
  assert.equal(remoteClick(node, [{ address: "t1", state: "live" }]).kind, "open");
});
