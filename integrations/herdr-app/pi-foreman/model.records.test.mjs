import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRadarDoc, buildTree, parseRecords, nodeStatus, agentStatus, agentsText, sessionRows, radarBinary } from "./model.js";

// A capture of `hc get <terminal> --json`: `records` is an object keyed by record id.
const SAMPLE = readFileSync(new URL("./hc-get-sample.json", import.meta.url), "utf8");

test("parseRecords: working and blocked pi-subagents records only (object keyed by id)", () => {
  assert.deepEqual(parseRecords(SAMPLE), [
    { title: "explorer", state: "working", msg: "Running bash" },
    { title: "builder", state: "working", msg: "Editing files" },
    { title: "reviewer", state: "blocked", msg: "Waiting for an answer" },
  ]);
});

test("parseRecords: array shape and other apps", () => {
  const arr = JSON.stringify({ records: [
    { state: "working", title: "explorer", msg: "Running bash", app: "pi-subagents" },
    { state: "working", title: "other", msg: "x", app: "some-tool" },
  ] });
  assert.deepEqual(parseRecords(arr), [{ title: "explorer", state: "working", msg: "Running bash" }]);
});

test("parseRecords: bad input answers []", () => {
  for (const bad of ["", "nope", "null", "[]", "{}", '{"records":5}', '{"records":[null,7,{"app":"pi-subagents"}]}', '{"records":{"a":null,"b":7,"c":{"app":"pi-subagents"}}}']) {
    assert.deepEqual(parseRecords(bad), []);
  }
});

const working = parseRecords(JSON.stringify({ records: [{ state: "working", title: "explorer", app: "pi-subagents" }] }));
const blocked = parseRecords(JSON.stringify({ records: [{ state: "blocked", title: "reviewer", app: "pi-subagents" }] }));

test("terminal with no radar node: records give the status and the text", () => {
  assert.equal(nodeStatus(null, "idle", working), "agents");
  assert.equal(nodeStatus(null, "idle", blocked), "blocked");
  assert.equal(nodeStatus(null, "working", working), "working");
  assert.equal(nodeStatus(null, "idle", []), "idle");
  assert.equal(agentsText(null, parseRecords(SAMPLE)), "3 agents: explorer, builder, reviewer");
  assert.equal(agentsText(null, working), "1 agent: explorer");
  assert.equal(agentsText(null, []), "");
});

test("agentStatus keeps the listed status when nothing more is known", () => {
  assert.equal(agentStatus("idle", null, working), "agents");
  assert.equal(agentStatus("unknown", null, []), "unknown");
  assert.equal(agentStatus("blocked", null, []), "blocked");
});

const sample = JSON.parse(readFileSync(new URL("./radar-sample.json", import.meta.url), "utf8"));
const tops = buildTree(parseRadarDoc(JSON.stringify(sample)).nodes);
const byName = (name) => tops.find((t) => t.name === name);

test("real radar document: blocked, working and agents from state/sym", () => {
  assert.equal(nodeStatus(byName("asker")), "blocked");
  assert.equal(nodeStatus(byName("worker")), "working");
  assert.equal(nodeStatus(byName("fanout")), "agents");
  assert.equal(nodeStatus(byName("fanout"), "idle"), "agents");
});

test("radar runs stay the source: records are de-duplicated by title", () => {
  const fan = byName("fanout"); // radar runs: builder, reviewer
  const recs = [{ title: "builder", state: "working" }, { title: "explorer", state: "working" }];
  assert.equal(agentsText(fan, []), "2 agents: builder, reviewer");
  assert.equal(agentsText(fan, [{ title: "builder", state: "working" }]), "2 agents: builder, reviewer");
  assert.equal(agentsText(fan, recs), "3 agents: builder, reviewer, explorer");
  assert.equal(sessionRows(fan, "idle", recs).ask, "3 agents: builder, reviewer, explorer");
  assert.equal(sessionRows(fan, "idle", recs).status, "agents");
});

test("blocked record is a need, but the agents text is not red", () => {
  const idle = byName("worker");
  const r = sessionRows({ ...idle, state: "idle", sym: "waiting" }, "idle", blocked);
  assert.equal(r.status, "blocked");
  assert.equal(r.ask, "1 agent: reviewer");
  assert.equal(r.blocked, false);
});

test("hc binary prop falls back to hc", () => {
  assert.equal(radarBinary(undefined, null, "hc"), "hc");
  assert.equal(radarBinary({ local: "/a/hc" }, null, "hc"), "/a/hc");
  assert.equal(radarBinary({ local: "/a/hc" }, "box", "hc"), "hc");
});
