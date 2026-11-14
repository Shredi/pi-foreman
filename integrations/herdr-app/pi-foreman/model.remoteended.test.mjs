import test from "node:test";
import assert from "node:assert/strict";
import { hcChildItems, endedRemoteNodesOf, dropDrawnEndedMirrors, attachName, parseRecords, sessionTree } from "./model.js";
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

test("the ended mirror's item carries the pane of its resolved terminal", () => {
  const withPane = hcChildItems([...base, mirrorTerm()], "t1", () => ({ ...resolve(), pane: "p7" }), { endedNodes: [ended()] });
  assert.equal(withPane[0].pane, "p7");
  assert.equal("pane" in hcChildItems([...base, mirrorTerm()], "t1", resolve, { endedNodes: [ended()] })[0], false);
});

test("the ended mirror's item carries its target", () => {
  assert.equal(hcChildItems([...base, mirrorTerm()], "t1", resolve, { endedNodes: [ended()] })[0].ended, "box1/t1k");
});

// dropDrawnEndedMirrors: an ended mirror item whose target a registry node drawn in the same tree has goes, its children take its place.
const item = (id, urgent, over = {}) => ({ id, type: "session", node: null, status: urgent, urgent, children: [], ...over });
const drawnNode = item("reg", "idle", { node: { machine: "box1", hcTerminal: "box1/t1k" } });

test("dropDrawnEndedMirrors drops the mirror of a drawn target and hoists its children, sorted among the siblings", () => {
  const kid = item("kid", "working");
  const mirror = item("m", "working", { ended: "box1/t1k", children: [kid] });
  const root = item("root", "working", { children: [item("a", "idle"), mirror, drawnNode] });
  const out = dropDrawnEndedMirrors({ root, items: root.children });
  assert.deepEqual(out.items.map((i) => i.id), ["kid", "a", "reg"]);
  assert.equal(out.root.children, out.items);
  assert.equal(out.root.urgent, "working");
  assert.equal(root.children.length, 3, "the input stays as it was");
});

test("dropDrawnEndedMirrors keeps the mirror item when its target is not drawn", () => {
  const mirror = item("m", "idle", { ended: "box1/t99", children: [item("kid", "idle")] });
  const input = { root: item("root", "idle", { children: [mirror, drawnNode] }), items: [] };
  input.items = input.root.children;
  const out = dropDrawnEndedMirrors(input);
  assert.equal(out.root, input.root);
  assert.equal(out.items, input.items);
  const bare = { root: null, items: [mirror] };
  assert.deepEqual(dropDrawnEndedMirrors(bare).items.map((i) => i.id), ["m"]);
});

test("dropDrawnEndedMirrors handles a mirror nested below another item, and bare items without a root", () => {
  const mirror = item("m", "idle", { ended: "box1/t1k", children: [item("kid", "idle")] });
  const mid = item("mid", "idle", { children: [mirror] });
  const out = dropDrawnEndedMirrors({ root: null, items: [mid, drawnNode] });
  assert.deepEqual(out.items.map((i) => i.id), ["mid", "reg"]);
  assert.deepEqual(out.items[0].children.map((i) => i.id), ["kid"]);
  assert.equal(out.root, null);
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
