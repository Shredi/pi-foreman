import test from "node:test";
import assert from "node:assert/strict";
import { buildTree, joinAgents, joinChildren, sessionTree, agentLines, parseRecords, agentStatus, sessionRows } from "./model.js";

const sess = (name, hcTerminal, extra = {}) => ({
  key: name, kind: "session", name, hcTerminal, state: "working", sym: "", pid: null, machine: "", parent: "",
  waits: [], tasks: [], asks: [], prs: [], children: [], cost: 0, ...extra,
});
const kid = (address, extra = {}) => ({ address, parent: "t1", state: "live", status: "idle", ...extra });

test("join by hcTerminal to a pane-less child", () => {
  const tree = buildTree([sess("a", "t12"), sess("b", "t13")]);
  const m = joinChildren([kid("t12"), kid("t13")], tree);
  assert.equal(m.get("t12").name, "a");
  assert.equal(m.get("t13").name, "b");
});

test("no join: no hcTerminal, other terminal, done node", () => {
  const tree = buildTree([sess("a", ""), sess("b", "t99"), sess("c", "t12", { state: "done" })]);
  assert.equal(joinChildren([kid("t12"), kid("t13")], tree).size, 0);
});

test("remote prefix", () => {
  const tree = buildTree([sess("a", "t12")]);
  assert.equal(joinChildren([kid("box/t12")], tree, "box").get("box/t12").name, "a");
  assert.equal(joinChildren([kid("box/t12")], tree).size, 0);
});

test("a node joins one terminal, and not one already taken by a paned agent", () => {
  const tree = buildTree([sess("a", "t12")]);
  const [n] = tree;
  assert.equal(joinChildren([kid("t12"), kid("t12")], tree).size, 1);
  assert.equal(joinChildren([kid("t12")], tree, null, new Set([n])).size, 0);
});

test("no double drawing: skipping the joined node removes its nested row under the paned parent", () => {
  const child = sess("kid", "t12", { parent: "top" });
  const tree = buildTree([sess("top", "t1", { children: [child] })]);
  const [top] = tree;
  const joined = joinAgents([{ address: "t1" }], tree);
  const cj = joinChildren([kid("t12")], tree, null, new Set(joined.values()));
  assert.equal(cj.size, 1);
  assert.deepEqual(sessionTree(top, { skip: new Set([...joined.values(), ...cj.values()]) }).children, []);
  assert.equal(sessionTree(top).children.length, 1);
});

test("detail rows of a child: wait text, records, PR chips", () => {
  const prs = [{ number: 50, checks: ["pending"], url: "", repo: "" }];
  const [n] = buildTree([sess("w", "t12", { waits: [{ kind: "pr_watch", note: "PR #50 checks", ageS: 540 }], prs })]);
  const r = sessionRows(n, "idle", []);
  assert.equal(r.ask, "wait: PR #50 checks 9m");
  assert.equal(r.prs.length, 1);
  const recs = parseRecords(JSON.stringify({ records: { a: { app: "pi-subagents", state: "working", title: "reviewer", msg: "Running bash" } } }));
  assert.deepEqual(agentLines(n, recs), [{ glyph: "working", text: "reviewer · Running bash" }]);
  assert.equal(sessionRows(n, "idle", recs).ask, "1 agent: reviewer");
  assert.equal(agentStatus("idle", n, recs), "agents");
});

test("records per child stay separate", () => {
  const a = parseRecords(JSON.stringify({ records: [{ app: "pi-subagents", state: "working", title: "x" }] }));
  assert.equal(agentLines(null, a).length, 1);
  assert.equal(agentLines(null, []).length, 0);
});

test("nested sessions of a joined child are tree items", () => {
  const inner = sess("inner", "", { parent: "outer" });
  const [outer] = buildTree([sess("outer", "t12", { children: [inner] })]);
  const cj = joinChildren([kid("t12")], [outer]);
  const items = sessionTree(cj.get("t12"), { skip: new Set(cj.values()) }).children;
  assert.equal(items.length, 1);
  assert.equal(items[0].label, "inner");
});
