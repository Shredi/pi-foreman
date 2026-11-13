import test from "node:test";
import assert from "node:assert/strict";
import { agentLines, detailLine, parseRadarDoc, parseRecords, sessionRows } from "./model.js";

const doc = (records) => JSON.stringify({ records });
const bare = (over = {}) => ({ name: "s", children: [], workers: [], sessions: [], waits: [], tasks: [], asks: [], prs: [], ...over });
const A = { id: "agentid-0001-long", label: "explorer", ageS: 30 };
const S = { id: "shellid-0002-long", label: "npm test", ageS: 5 };
const recs = parseRecords(doc({
  "background-agents/agentid-0001": { app: "pi-foreman", state: "working", title: "explorer", msg: "Running" },
  "background-tasks/shellid-0002": { app: "pi-foreman", state: "working", title: "npm test", msg: "Running" },
}));

test("agent A and shell S: the gear line names S only, A is one robot row", () => {
  const n = bare({ tasks: [A, S] });
  assert.equal(detailLine(n, recs).text, "bg: npm test 5s");
  assert.equal(sessionRows(n, null, recs).ask, "1 agent: explorer");
  assert.deepEqual(agentLines(n, recs), [{ glyph: "working", text: "explorer · Running" }]);
});

test("only the agent task: no gear line, one robot row", () => {
  const n = bare({ tasks: [A] });
  const only = parseRecords(doc({ "background-agents/agentid-0001": { app: "pi-foreman", state: "working", title: "explorer", msg: "Running" } }));
  assert.equal(detailLine(n, only).text, "");
  assert.equal(agentLines(n, only).length, 1);
});

test("two shell tasks keep first +1", () => {
  const n = bare({ tasks: [S, { id: "shellid-0003-long", label: "lint", ageS: 1 }] });
  assert.equal(detailLine(n, recs).text, "bg: npm test 5s +1");
});

test("a parsed radar node keeps the task id and the gear line honours it", () => {
  const parsed = parseRadarDoc(JSON.stringify({ roots: [{ name: "top", tasks: [{ id: A.id, label: "explorer", ageSeconds: 30 }, { id: S.id, label: "npm test", ageSeconds: 5 }] }] })).nodes[0];
  assert.equal(parsed.tasks[0].id, A.id);
  assert.equal(detailLine(parsed, recs).text, "bg: npm test 5s");
});

test("without records the gear line is unchanged", () => {
  assert.equal(detailLine(bare({ tasks: [A, S] })).text, "bg: explorer 30s +1");
});
