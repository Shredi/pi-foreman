import test from "node:test";
import assert from "node:assert/strict";
import { agentLines, parseRecords, treeItems } from "./model.js";

const run = (role, ageS, extra = {}) => ({ kind: "run", name: role, role, state: "working", ended: false, ageS, children: [], ...extra });
const node = (...runs) => ({ name: "s", children: runs, workers: [], sessions: [], waits: [], tasks: [], asks: [], prs: [] });
const recs = (...rows) => parseRecords(JSON.stringify({ records: rows.map(([title, state, msg]) => ({ app: "pi-subagents", title, state, msg })) }));

test("records only: title and msg, working glyph", () => {
  assert.deepEqual(agentLines(null, recs(["explorer", "working", "Running bash"])), [{ glyph: "working", text: "explorer · Running bash" }]);
  assert.deepEqual(agentLines(node(), recs(["explorer", "working", ""])), [{ glyph: "working", text: "explorer" }]);
});

test("radar only: role and age", () => {
  assert.deepEqual(agentLines(node(run("reviewer", 250)), []), [{ glyph: "working", text: "reviewer · 4m" }]);
});

test("both: a record cancels the radar run of the same title", () => {
  const out = agentLines(node(run("reviewer", 250), run("builder", 30)), recs(["reviewer", "working", "Reading"]));
  assert.deepEqual(out, [{ glyph: "working", text: "reviewer · Reading" }, { glyph: "working", text: "builder · 30s" }]);
});

test("blocked record has the blocked glyph", () => {
  assert.equal(agentLines(null, recs(["explorer", "blocked", "Waiting"]))[0].glyph, "blocked");
});

test("done records are not shown", () => {
  assert.deepEqual(agentLines(null, recs(["explorer", "done", "Finished"])), []);
  assert.deepEqual(agentLines(node(run("old", 9, { ended: true })), []), []);
});

test("cap at 4 lines, then +N more", () => {
  const out = agentLines(null, recs(...["a", "b", "c", "d", "e", "f"].map((t) => [t, "working", "x"])));
  assert.equal(out.length, 5);
  assert.deepEqual(out[4], { glyph: "", text: "+2 more" });
  assert.equal(agentLines(null, recs(...["a", "b", "c", "d"].map((t) => [t, "working", "x"]))).length, 4);
});

test("nested session items carry their radar lines", () => {
  const top = { ...node(), sessions: [node(run("reviewer", 70))], workers: [] };
  const items = treeItems(top);
  assert.deepEqual(items[0].agents, [{ glyph: "working", text: "reviewer · 1m" }]);
});
