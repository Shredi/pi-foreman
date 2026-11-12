import test from "node:test";
import assert from "node:assert/strict";
import { hcChildItems, remoteTwins, remoteNodesOf, attachName } from "./model.js";
import { sess, treeOf } from "./fixtures.mjs";

// One remote child: registry row b (`label@box1`), its local mirror terminal (named by hc run --name, parent set) and the remote
// machine's own terminal box1/t7 (no parent).
const regNode = (over = {}) => sess("fm-label-a1b2c3", "label@box1", { machine: "box1", hcTerminal: "box1/t7", state: "working", sym: "working", parent: "p", ...over });
const tree = (kid = regNode()) => treeOf(sess("p", "parent", { hcTerminal: "t1" }, [kid]));
const mirrorName = attachName("box1", "fm-label-a1b2c3");
const terms = (mirror = {}) => [
  { address: "t1", state: "live", name: "parent" },
  { address: "t3", state: "live", name: mirrorName, parent: "t1", argv: ["hc", "attach", "box1/t7"], ...mirror },
];
const draw = (all, root = tree(), extra = {}) => {
  const nodes = remoteNodesOf([root]);
  const resolve = () => ({ node: null, recs: [], own: "idle", status: "idle" });
  return hcChildItems(all, "t1", resolve, { drawnTargets: new Set(nodes.map((x) => x.target)), remoteNodes: nodes, ...extra });
};
const addrs = (items) => items.flatMap((i) => [i.address, ...addrs(i.children)]).filter(Boolean);

test("remoteNodesOf lists the live remote registry nodes with the attach name of each", () => {
  assert.deepEqual(remoteNodesOf([tree()]), [{ target: "box1/t7", name: mirrorName }]);
  assert.deepEqual(remoteNodesOf([tree(regNode({ state: "done" }))]), []);
  assert.deepEqual(remoteNodesOf([tree(regNode({ machine: "" }))]), []);
});

test("the named mirror is no row when its argv follows the attach of a drawn registry node", () => {
  assert.deepEqual(addrs(draw(terms())), []);
});

test("the named mirror is recognised by its name when the record has no argv", () => {
  assert.deepEqual(addrs(draw(terms({ argv: undefined }))), []);
});

test("the mirror's own children stay when the mirror is no row", () => {
  const all = [...terms(), { address: "t4", state: "live", name: "shell", parent: "t3" }];
  assert.deepEqual(addrs(draw(all)), ["t4"]);
});

test("a named terminal that does not follow a known remote node keeps its row", () => {
  assert.deepEqual(addrs(draw(terms({ argv: ["hc", "attach", "box1/t99"], name: "other" }))), ["t3"]);
  assert.deepEqual(addrs(draw(terms({ argv: undefined, name: "fm-box1-other-ffff" }))), ["t3"]);
  assert.deepEqual(addrs(draw(terms({ argv: undefined, name: "build" }))), ["t3"]);
});

test("an ambiguous name (two remote nodes, one name) is not matched", () => {
  const twin = sess("fm-label-zzb2c3", "label@box2", { machine: "box1", hcTerminal: "box1/t8", state: "working", parent: "p" });
  const two = treeOf(sess("p", "parent", { hcTerminal: "t1" }, [regNode(), twin]));
  assert.equal(attachName("box1", "fm-label-zzb2c3"), mirrorName);
  assert.deepEqual(addrs(draw(terms({ argv: undefined }), two)), ["t3"]);
  assert.deepEqual(addrs(draw(terms(), two)), [], "argv still decides");
});

test("a mirror of a target no registry node draws is kept (the target is only a listed agent)", () => {
  const items = hcChildItems(terms(), "t1", () => ({ node: null, recs: [], own: "idle", status: "idle" }), { drawnTargets: new Set(["box1/t7"]), remoteNodes: [] });
  assert.deepEqual(addrs(items), ["t3"]);
});

test("remoteTwins: a listed remote terminal that a live local registry node names is that node's row", () => {
  const list = [{ address: "t1" }, { address: "box1/t7" }, { address: "box1/t9" }, { address: "box2/t7" }];
  assert.deepEqual([...remoteTwins(list, remoteNodesOf([tree()]))], ["box1/t7"]);
  assert.deepEqual([...remoteTwins(list, remoteNodesOf([tree(regNode({ state: "done" }))]))], []);
  assert.deepEqual([...remoteTwins(list, remoteNodesOf([tree(regNode({ state: "closed", ended_s: 3 }))]))], []);
  assert.deepEqual([...remoteTwins(list, remoteNodesOf(null))], []);
});
