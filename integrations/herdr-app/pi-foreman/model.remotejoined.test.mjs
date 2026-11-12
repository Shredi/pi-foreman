import test from "node:test";
import assert from "node:assert/strict";
import { sessionTree, parseRecords, remoteTarget, drawnRemoteTargets } from "./model.js";
import { sess, run, treeOf } from "./fixtures.mjs";

const rec = (title, over = {}) => ({ app: "pi-subagents", state: "working", title, msg: "reading", ...over });
const recs = (...r) => parseRecords(JSON.stringify({ records: r }));
const kid = (item, label) => item.children.find((c) => c.label === label);

// The local registry child `label@box1` (remote terminal box1/t7) under p, and the remote radar node that joins box1/t7 under its own key.
const regNode = (over = {}) => sess("fm-label-a1b2c3", "label@box1", { machine: "box1", hcTerminal: "box1/t7", state: "idle", sym: "idle", parent: "p", ...over });
const tree = (reg = regNode()) => treeOf(sess("p", "parent", { hcTerminal: "t1" }, [reg]));
const remote = (over = {}, kids = []) => treeOf(sess("rem-label-9f8e7d", "label", { hcTerminal: "t7", state: "working", sym: "working", ...over }, kids));
const joinedTo = (r) => ({ remoteOf: (n) => (n.machine ? r : null), recsOf: (n) => (n.hcTerminal === "box1/t7" ? recs(rec("scout"), rec("reviewer")) : []) });

test("a registry child joined to its remote node shows that node's agents once, then the records not among them", () => {
  const item = sessionTree(tree(), joinedTo(remote({}, [run("r1", "scout", { model: "" })])));
  assert.deepEqual(kid(item, "label@box1").children.map((c) => c.label), ["scout", "reviewer · reading"]);
});

test("the joined node's status counts: an idle registry child with a working remote node is working", () => {
  const row = kid(sessionTree(tree(), joinedTo(remote())), "label@box1");
  assert.equal(row.status, "working");
});

test("the joined node's PRs are on the registry row, one per number", () => {
  const r = remote();
  r.prs = [{ number: 7, repo: "owner/repo-a", state: "open", title: "remote pr" }];
  const row = kid(sessionTree(tree(regNode({ prs: [{ number: 7, repo: "owner/repo-a", state: "open", title: "local pr" }] })), joinedTo(r)), "label@box1");
  assert.deepEqual(row.prs.map((p) => p.number), [7]);
});

test("the joined remote node is drawn under the registry row only, not at the root", () => {
  const item = sessionTree(tree(), joinedTo(remote({}, [run("r1", "scout", { model: "" })])));
  assert.deepEqual(item.children.map((c) => c.label), ["label@box1"]);
  assert.equal(item.children.filter((c) => c.type === "agent").length, 0);
});

test("without a joined node the registry row is as before", () => {
  const row = kid(sessionTree(tree(), { recsOf: (n) => (n.hcTerminal === "box1/t7" ? recs(rec("scout")) : []) }), "label@box1");
  assert.deepEqual(row.children.map((c) => c.label), ["scout · reading"]);
});

test("remoteTarget and drawnRemoteTargets name the remote terminal of a registry node", () => {
  assert.equal(remoteTarget(regNode()), "box1/t7");
  assert.equal(remoteTarget(regNode({ hcTerminal: "box1/t8" })), "box1/t8");
  assert.equal(remoteTarget(sess("p", "parent", { hcTerminal: "t1" })), "");
  assert.deepEqual([...drawnRemoteTargets([sessionTree(tree(), {})])], ["box1/t7"]);
});
