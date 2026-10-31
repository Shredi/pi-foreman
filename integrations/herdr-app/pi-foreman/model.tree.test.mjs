import test from "node:test";
import assert from "node:assert/strict";
import { sessionTree, displayStatus, detailLine } from "./model.js";
import { sess, run, treeOf } from "./fixtures.mjs";

// root: agents builder (working, age 50) + reviewer (ended); child c1 (idle, age 300) with agent explorer (working, age 5)
// and grandchild g1 (waiting, age 90); child c2 (asking, age 20).
const root = () => treeOf(sess("root", "root", { state: "idle", cost: 1 }, [
  run("b", "builder", { age_s: 50 }),
  run("rv", "reviewer", { state: "done", sym: "done", ended_s: 3 }),
  sess("c1", "c1", { age_s: 300, cost: 0.5 }, [
    run("e", "explorer", { age_s: 5 }),
    sess("g1", "g1", { age_s: 90, sym: "waiting-external", waits: [{ kind: "ci", note: "ci", age_s: 4 }] }),
  ]),
  sess("c2", "c2", { age_s: 20, state: "ask", sym: "needs-you", asks: [{ n: 1, topic: "q" }] }),
]));

const labels = (items) => items.map((i) => i.label);
const B = "builder haiku-5-5:medium";
const E = "explorer haiku-5-5:medium";

test("own agents and child sessions are siblings in one list; ended agents are left out", () => {
  const t = sessionTree(root());
  assert.equal(t.type, "session");
  assert.deepEqual(t.children.map((c) => [c.type, c.label]).sort(), [["agent", B], ["session", "c1"], ["session", "c2"]]);
});

test("each child session carries its own agents and children; an agent has no children", () => {
  const t = sessionTree(root());
  const c1 = t.children.find((c) => c.label === "c1");
  assert.deepEqual(c1.children.map((c) => [c.type, c.label]).sort(), [["agent", E], ["session", "g1"]]);
  for (const c of t.children.filter((c) => c.type === "agent")) assert.deepEqual(c.children, []);
});

test("urgency order puts the blocked session first, then working, then agents", () => {
  const t = sessionTree(root());
  assert.deepEqual(labels(t.children), ["c2", B, "c1"]);
  const c1 = t.children.find((c) => c.label === "c1");
  assert.deepEqual(labels(c1.children), [E, "g1"]);
});

test("no summary line: records become agent rows, capped with +N more", () => {
  const recs = ["a", "b", "c", "d", "e", "f"].map((title) => ({ title, state: "working", msg: "" }));
  const t = sessionTree(treeOf(sess("s", "s")), { recs });
  assert.equal(t.children.filter((c) => c.type === "agent").length, 4);
  assert.deepEqual(t.children.at(-1), { id: "s/r4", type: "more", label: "+2 more", status: "idle", urgent: "idle", children: [] });
  assert.equal(detailLine(treeOf(sess("s", "s", {}, [run("r", "builder")]))).text, "");
});

test("detailLine: ask first (blocked), then waits", () => {
  const c2 = root().sessions.find((s) => s.name === "c2");
  assert.deepEqual(detailLine(c2), { text: "ask 1: q", blocked: true });
  assert.deepEqual(detailLine(root().sessions.find((s) => s.name === "c1").sessions[0]), { text: "wait: ci 4s", blocked: false });
});

test("a session in skip, and an ended session, are not in the tree", () => {
  const r = root();
  const c1 = r.sessions.find((s) => s.name === "c1");
  assert.ok(!labels(sessionTree(r, { skip: new Set([c1]) }).children).includes("c1"));
  const ended = treeOf(sess("s", "s", {}, [sess("x", "x", { state: "done", ended_s: 1 })]));
  assert.deepEqual(sessionTree(ended).children, []);
});

test("urgent is the most urgent status in the subtree; folding shows it, unfolding shows the own status", () => {
  const t = sessionTree(root());
  const c1 = t.children.find((c) => c.label === "c1");
  assert.equal(c1.status, "agents");
  assert.equal(c1.urgent, "working");
  assert.equal(displayStatus(c1, new Set()), "agents");
  assert.equal(displayStatus(c1, new Set([c1.id])), "working");
  assert.equal(t.urgent, "blocked");
  assert.equal(displayStatus(t, new Set([t.id])), "blocked");
});

test("folding a leaf changes nothing; ids are unique", () => {
  const t = sessionTree(root());
  const ids = [];
  const walk = (i) => { ids.push(i.id); i.children.forEach(walk); };
  walk(t);
  assert.equal(new Set(ids).size, ids.length);
  const leaf = t.children.find((c) => c.type === "agent");
  assert.equal(displayStatus(leaf, new Set([leaf.id])), leaf.status);
});

test("the root shows total cost and session count, a child its own cost", () => {
  const t = sessionTree(root());
  assert.equal(t.costText, "$1.50");
  assert.equal(t.sessions, 4);
  assert.equal(t.children.find((c) => c.label === "c1").costText, "$0.50");
});

test("bad input gives null", () => {
  assert.equal(sessionTree(null), null);
  assert.equal(sessionTree("x"), null);
});
