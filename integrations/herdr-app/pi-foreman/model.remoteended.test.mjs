import test from "node:test";
import assert from "node:assert/strict";
import { hcChildItems, endedRemoteNodesOf, attachName, parseRecords, sessionTree } from "./model.js";
import { sess, treeOf } from "./fixtures.mjs";

// Remote registry children `label@box1` of the local session p; each follows the remote terminal box1/<t>.
const KA = "fm-alpha-a1b2c3";
const KB = "fm-alpha-x1b2c3";
const regNode = (key, label, state, target) => sess(key, `${label}@box1`, { machine: "box1", hcTerminal: target, state, parent: "p" });
const tree = (kids) => treeOf(sess("p", "parent", { hcTerminal: "t1" }, kids));
const mirrorName = attachName("box1", KA);
const resolve = () => ({ node: null, recs: [], own: "idle", status: "idle" });
const addrs = (items) => items.flatMap((i) => [i.address, ...addrs(i.children)]).filter(Boolean);
const ended = (over = {}) => ({ target: "box1/t1k", name: mirrorName, label: "alpha-inventory@box1", machine: "box1", ...over });

test("endedRemoteNodesOf lists the remote registry nodes that have ended, with the name, label and machine of each", () => {
  assert.deepEqual(endedRemoteNodesOf([tree([regNode(KA, "alpha-inventory", "closed", "box1/t1k")])]), [ended()]);
  assert.deepEqual(endedRemoteNodesOf([tree([regNode(KA, "alpha-inventory", "finished", "box1/t1k")])]), [ended()]);
  assert.deepEqual(endedRemoteNodesOf([tree([regNode(KA, "alpha-inventory", "lost", "box1/t1k")])]), [ended()]);
});

test("endedRemoteNodesOf leaves out the live, done and local nodes, and a lost one that is only late", () => {
  assert.deepEqual(endedRemoteNodesOf([tree([regNode(KA, "alpha-inventory", "working", "box1/t1k")])]), []);
  assert.deepEqual(endedRemoteNodesOf([tree([regNode(KA, "alpha-inventory", "done", "box1/t1k")])]), []);
  assert.deepEqual(endedRemoteNodesOf([tree([{ ...regNode(KA, "alpha-inventory", "lost", "box1/t1k"), regOpen: true }])]), []);
  assert.deepEqual(endedRemoteNodesOf([tree([regNode(KA, "alpha-inventory", "closed", "")])]), []);
  assert.deepEqual(endedRemoteNodesOf(null), []);
});

// The live mirror of an ended node: one dimmed item named as the session, with its machine chip and its address; its children stay.
const mirrorTerm = (over = {}) => ({ address: "t3", state: "live", name: mirrorName, parent: "t1", argv: ["hc", "attach", "box1/t1k"], ...over });
const base = [{ address: "t1", state: "live", name: "parent" }];

test("the live mirror of an ended node is one dimmed row named as the session, with the machine and the mirror's address", () => {
  const items = hcChildItems([...base, mirrorTerm()], "t1", resolve, { endedNodes: [ended()] });
  assert.equal(items.length, 1);
  const [it] = items;
  assert.equal(it.label, "alpha-inventory@box1");
  assert.equal(it.dim, true);
  assert.equal(it.elsewhere, "box1");
  assert.equal(it.address, "t3");
  assert.equal(it.status, "idle");
  assert.equal(it.node, null);
  assert.deepEqual(it.prs, []);
  assert.equal(it.costText, "");
});

test("the ended mirror's own children stay beneath its row", () => {
  const all = [...base, mirrorTerm(), { address: "t4", state: "live", name: "shell", parent: "t3" }];
  const items = hcChildItems(all, "t1", resolve, { endedNodes: [ended()] });
  assert.deepEqual(addrs(items), ["t3", "t4"]);
  assert.deepEqual(items[0].children.map((c) => c.address), ["t4"]);
});

test("the ended mirror is matched by its name when its record has no argv", () => {
  const items = hcChildItems([...base, mirrorTerm({ argv: undefined })], "t1", resolve, { endedNodes: [ended()] });
  assert.equal(items[0].label, "alpha-inventory@box1");
  assert.equal(items[0].elsewhere, "box1");
});

test("an ended mirror whose argv names a target no ended node has keeps its own row", () => {
  const items = hcChildItems([...base, mirrorTerm({ argv: ["hc", "attach", "box1/t99"] })], "t1", resolve, { endedNodes: [ended()] });
  assert.equal(items[0].label, mirrorName);
  assert.equal(items[0].elsewhere, "");
  assert.equal(items[0].dim, false);
});

test("an ambiguous name (two ended nodes with one attach name) is not matched", () => {
  const two = [ended(), ended({ target: "box1/t1m", label: "alpha-prechecks@box1" })];
  assert.equal(attachName("box1", KB), mirrorName);
  const items = hcChildItems([...base, mirrorTerm({ argv: undefined })], "t1", resolve, { endedNodes: two });
  assert.equal(items[0].label, mirrorName);
  assert.equal(items[0].dim, false);
});

test("a live remote node is not an ended one: its mirror stays no row (remoteNodes decides)", () => {
  const remoteNodes = [{ target: "box1/t1k", name: mirrorName }];
  assert.deepEqual(addrs(hcChildItems([...base, mirrorTerm()], "t1", resolve, { remoteNodes, endedNodes: [] })), []);
});

// The activity of an idle remote child: its remote terminal's working pi-subagents record shows as status `agents`, one agent row.
test("an idle remote child whose remote terminal has a working pi-subagents record shows agents and one agent row", () => {
  const recs = parseRecords(JSON.stringify({ records: { "subagents/abc": { app: "pi-subagents", msg: "Running", state: "working", title: "builder" } } }));
  const item = sessionTree(tree([regNode(KA, "alpha-inventory", "idle", "box1/t1k")]), { recsOf: (n) => (n.hcTerminal === "box1/t1k" ? recs : []), top: true });
  const c = item.children.find((x) => x.label === "alpha-inventory@box1");
  assert.equal(c.status, "agents");
  assert.equal(c.urgent, "working");
  assert.deepEqual(c.children.filter((x) => x.type === "agent").map((x) => x.status), ["working"]);
});
