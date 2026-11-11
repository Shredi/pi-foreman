import test from "node:test";
import assert from "node:assert/strict";
import { agentLines, agentsText, nodeStatus, parseRecords, sessionRows, sessionTree } from "./model.js";

const doc = (records) => JSON.stringify({ records });
const bare = (over = {}) => ({ name: "s", children: [], workers: [], sessions: [], waits: [], tasks: [], asks: [], prs: [], ...over });

test("a working shell task: no agent row, not counted, the session stays busy", () => {
  const recs = parseRecords(doc({ "background-tasks/a1": { app: "pi-foreman", state: "working", title: "npm test", msg: "Running" } }));
  assert.deepEqual(recs, [{ title: "npm test", state: "working", msg: "Running", task: true }]);
  assert.deepEqual(agentLines(null, recs), []);
  assert.equal(agentsText(null, recs), "");
  assert.deepEqual(sessionTree(bare(), { recs }).children, []);
  assert.equal(nodeStatus(null, null, recs), "agents");
  assert.equal(nodeStatus(bare(), null, recs), "agents");
});

test("a working background-agents record: an agent row, as a subagent record gives one", () => {
  const recs = parseRecords(doc({ "background-agents/b1": { app: "pi-foreman", state: "working", title: "explorer", msg: "Running bash" } }));
  assert.deepEqual(recs, [{ title: "explorer", state: "working", msg: "Running bash" }]);
  assert.deepEqual(agentLines(null, recs), [{ glyph: "working", text: "explorer · Running bash" }]);
  assert.equal(agentsText(null, recs), "1 agent: explorer");
});

test("a shell task beside a subagent record: only the subagent is a row and counted", () => {
  const recs = parseRecords(doc({
    "subagents/abc": { app: "pi-subagents", state: "working", title: "reviewer", msg: "Reading" },
    "background-tasks/a1": { app: "pi-foreman", state: "working", title: "npm test", msg: "Running" },
  }));
  assert.deepEqual(agentLines(null, recs), [{ glyph: "working", text: "reviewer · Reading" }]);
  assert.equal(agentsText(null, recs), "1 agent: reviewer");
});

test("several shell tasks: the gear line keeps its +N, no agent row", () => {
  const n = bare({ tasks: [{ label: "npm test", ageS: 130 }, { label: "lint", ageS: 5 }, { label: "serve", ageS: 1 }] });
  const recs = parseRecords(doc({
    "background-tasks/a1": { app: "pi-foreman", state: "working", title: "npm test", msg: "Running" },
    "background-tasks/a2": { app: "pi-foreman", state: "working", title: "lint", msg: "Running" },
    "background-tasks/a3": { app: "pi-foreman", state: "working", title: "serve", msg: "Running" },
  }));
  assert.equal(sessionRows(n, null, recs).ask, "bg: npm test 2m +2");
  assert.deepEqual(sessionTree(n, { recs }).children, []);
});

test("the key decides, not the name: same title, one shell task and one agent", () => {
  const recs = parseRecords(doc({
    "background-tasks/a1": { app: "pi-foreman", state: "working", title: "build", msg: "Running" },
    "background-agents/b1": { app: "pi-foreman", state: "working", title: "build", msg: "Running" },
  }));
  assert.deepEqual(agentLines(null, recs), [{ glyph: "working", text: "build · Running" }]);
  assert.equal(agentsText(null, recs), "1 agent: build");
});

test("a shell task titled like a subagent gets no agent row", () => {
  const recs = parseRecords(doc({ "background-tasks/a1": { app: "pi-foreman", state: "working", title: "explorer", msg: "Running" } }));
  assert.deepEqual(agentLines(null, recs), []);
  assert.equal(agentsText(null, recs), "");
});

test("a finished or failed shell task: no row, not running", () => {
  const recs = parseRecords(doc({
    "background-tasks/d1": { app: "pi-foreman", state: "done", title: "npm test", msg: "Finished" },
    "background-tasks/e1": { app: "pi-foreman", state: "error", title: "lint", msg: "Failed" },
  }));
  assert.deepEqual(recs, []);
  assert.deepEqual(agentLines(null, recs), []);
  assert.equal(nodeStatus(null, null, recs), "idle");
});
