import test from "node:test";
import assert from "node:assert/strict";
import { sessionTree, parseRecords } from "./model.js";
import { sess, treeOf } from "./fixtures.mjs";

const rec = (title, over = {}) => ({ app: "pi-subagents", state: "working", title, msg: "reading", ...over });
const recs = (...r) => parseRecords(JSON.stringify({ records: r }));
const tree = (kidOver = {}, kids = []) => treeOf(sess("p", "parent", { hcTerminal: "t1" }, [
  sess("fm-label-a1b2c3", "label@box1", { machine: "box1", hcTerminal: "box1/t7", state: "idle", sym: "idle", parent: "p", ...kidOver }, kids),
  sess("fm-local-ffff00", "local-kid", { hcTerminal: "t9", state: "idle", sym: "idle", parent: "p" }),
]));
const kid = (item, label) => item.children.find((c) => c.label === label);
const byTarget = (map) => (n) => map[n.hcTerminal] ?? [];

test("a child session row gets the record agents of its own lookup and the agents status", () => {
  const item = sessionTree(tree(), { recsOf: byTarget({ "box1/t7": recs(rec("scout")) }) });
  const row = kid(item, "label@box1");
  assert.deepEqual(row.children.map((c) => [c.type, c.label]), [["agent", "scout · reading"]]);
  assert.equal(row.status, "agents");
  assert.equal(row.urgent, "working", "the subagent row is working");
});

test("a working remote node stays working with records, and a blocked record makes it blocked", () => {
  assert.equal(kid(sessionTree(tree({ state: "working", sym: "working" }), { recsOf: byTarget({ "box1/t7": recs(rec("scout")) }) }), "label@box1").status, "working");
  assert.equal(kid(sessionTree(tree(), { recsOf: byTarget({ "box1/t7": recs(rec("scout", { state: "blocked" })) }) }), "label@box1").status, "blocked");
});

test("records per child stay separate: another child and the root do not get them", () => {
  const item = sessionTree(tree(), { recsOf: byTarget({ "box1/t7": recs(rec("scout")) }) });
  assert.deepEqual(kid(item, "local-kid").children, []);
  assert.equal(kid(item, "local-kid").status, "idle");
  assert.equal(item.children.filter((c) => c.type === "agent").length, 0, "not on the root");
});

test("without a lookup, or with none for the node, a child row is as before", () => {
  const plain = sessionTree(tree());
  assert.deepEqual(kid(plain, "label@box1").children, []);
  assert.equal(kid(plain, "label@box1").status, "idle");
  assert.deepEqual(kid(sessionTree(tree(), { recsOf: () => [] }), "label@box1").children, []);
});

test("a record of a run that radar shows as a worker row is not drawn twice", () => {
  const withRun = tree({}, [{ key: "r1", kind: "run", name: "scout", role: "scout", state: "working", sym: "working", own: { in: 0, out: 0, cost: 0, uncached: 0 }, tot: { in: 0, out: 0, cost: 0, uncached: 0 }, age_s: 1, children: [] }]);
  const row = kid(sessionTree(withRun, { recsOf: byTarget({ "box1/t7": recs(rec("scout")) }) }), "label@box1");
  assert.equal(row.children.filter((c) => c.label.startsWith("scout")).length, 1);
});
