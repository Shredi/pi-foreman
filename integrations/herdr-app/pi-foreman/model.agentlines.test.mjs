import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { agentLines, parseRecords, treeItems } from "./model.js";

const run = (role, ageS, extra = {}) => ({ kind: "run", name: role, role, state: "working", ended: false, ageS, children: [], ...extra });
const node = (...runs) => ({ name: "s", children: runs, workers: runs, sessions: [], waits: [], tasks: [], asks: [], prs: [] });
const recs = (...rows) => parseRecords(JSON.stringify({ records: rows.map(([title, state, msg]) => ({ app: "pi-subagents", title, state, msg })) }));

test("records only: title and msg, working glyph", () => {
  assert.deepEqual(agentLines(null, recs(["explorer", "working", "Running bash"])), [{ glyph: "working", text: "explorer · Running bash" }]);
  assert.deepEqual(agentLines(node(), recs(["explorer", "working", ""])), [{ glyph: "working", text: "explorer" }]);
});

test("radar only: no lines, the worker row is the line", () => {
  assert.deepEqual(agentLines(node(run("reviewer", 250)), []), []);
});

test("records + matching workers: lines only for the unmatched records", () => {
  const out = agentLines(node(run("reviewer", 250), run("builder", 30)), recs(["reviewer", "working", "Reading"], ["explorer", "working", "Running bash"], ["builder", "blocked", "Waiting"], ["builder", "working", "Editing"]));
  assert.deepEqual(out, [{ glyph: "working", text: "explorer · Running bash" }, { glyph: "working", text: "builder · Editing" }]);
});

test("blocked record has the blocked glyph", () => {
  assert.equal(agentLines(null, recs(["explorer", "blocked", "Waiting"]))[0].glyph, "blocked");
});

test("done records are not shown", () => {
  assert.deepEqual(agentLines(null, recs(["explorer", "done", "Finished"])), []);
});

test("an ended worker does not cancel a record", () => {
  assert.equal(agentLines(node(run("old", 9, { ended: true })), recs(["old", "working", "x"])).length, 1);
});

test("cap at 4 lines, then +N more", () => {
  const out = agentLines(null, recs(...["a", "b", "c", "d", "e", "f"].map((t) => [t, "working", "x"])));
  assert.equal(out.length, 5);
  assert.deepEqual(out[4], { glyph: "", text: "+2 more" });
  assert.equal(agentLines(null, recs(...["a", "b", "c", "d"].map((t) => [t, "working", "x"]))).length, 4);
});

test("nested session items carry no agent lines (field absent)", () => {
  const top = { ...node(), sessions: [node(run("reviewer", 70))], workers: [] };
  assert.equal("agents" in treeItems(top)[0], false);
});

test("a worker of a nested session with its own agent row does not cancel a record on the top terminal", () => {
  const nested = node(run("reviewer", 70));
  const top = { ...node(), sessions: [nested], workers: [] };
  const r = recs(["reviewer", "working", "x"]);
  assert.equal(agentLines(top, r).length, 0);
  assert.equal(agentLines(top, r, new Set([nested])).length, 1);
});

test("every running agent appears exactly once: worker rows plus record lines", () => {
  const top = node(run("reviewer", 250), run("builder", 30));
  const sample = parseRecords(readFileSync(new URL("./hc-get-sample.json", import.meta.url), "utf8")); // explorer, builder, reviewer(blocked)
  const rows = treeItems(top).filter((i) => i.worker).map((i) => i.label);
  const lines = agentLines(top, sample).map((l) => l.text);
  assert.deepEqual(rows, ["reviewer", "builder"]);
  assert.deepEqual(lines, ["explorer · Running bash"]);
  assert.equal(rows.length + lines.length, 3);
});
