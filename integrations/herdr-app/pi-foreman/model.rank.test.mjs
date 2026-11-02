import test from "node:test";
import assert from "node:assert/strict";
import { nodeStatus, agentStatus, STATUS_RANK, urgentStatus, glyphSpec } from "./model.js";
import { sess, run, treeOf } from "./fixtures.mjs";

const withAgents = () => treeOf(sess("s", "s", { state: "idle" }, [run("r1", "builder")]));
const noAgents = () => treeOf(sess("s", "s", { state: "idle" }));

test("rank order is hidden > blocked > working > agents > done > bg > waiting > idle", () => {
  assert.deepEqual(STATUS_RANK, ["hidden", "blocked", "working", "agents", "done", "bg", "waiting", "idle"]);
  assert.equal(urgentStatus(["idle", "done", "agents", "bg"]), "agents");
  assert.equal(urgentStatus(["done", "bg", "waiting"]), "done");
  assert.equal(urgentStatus([]), "idle");
});

test("a finished turn with its own agents still running shows agents, not done", () => {
  assert.equal(nodeStatus(withAgents(), "done"), "agents");
  assert.equal(agentStatus("done", withAgents()), "agents");
});

test("done only once all agents have finished", () => {
  const finished = treeOf(sess("s", "s", {}, [run("r1", "builder", { state: "done", sym: "done", ended_s: 5 })]));
  assert.equal(nodeStatus(finished, "done"), "done");
  assert.equal(nodeStatus(noAgents(), "done"), "done");
});

test("done with running pi-subagents records shows agents", () => {
  assert.equal(nodeStatus(noAgents(), "done", [{ title: "builder", state: "working", msg: "" }]), "agents");
  assert.equal(nodeStatus(null, "done", [{ title: "builder", state: "working", msg: "" }]), "agents");
});

test("working and blocked still outrank agents", () => {
  assert.equal(nodeStatus(withAgents(), "working"), "working");
  assert.equal(nodeStatus(withAgents(), "blocked"), "blocked");
});

test("agents glyph is the hollow spinner, done the filled dot", () => {
  assert.deepEqual([glyphSpec("agents").kind, glyphSpec("agents").hollow], ["spin", true]);
  assert.deepEqual([glyphSpec("done").kind, glyphSpec("done").hollow], ["dot", false]);
});
