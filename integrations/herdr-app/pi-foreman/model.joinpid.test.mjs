import test from "node:test";
import assert from "node:assert/strict";
import { joinAgents, joinChildren } from "./model.js";

const node = (key, over = {}) => ({ key, kind: "session", state: "working", hcTerminal: "", pid: null, machine: "", sessions: [], ...over });
const agent = (address, pid) => ({ address, foreground: { pid } });

test("a node without hcTerminal joins the terminal whose foreground pid equals its pid", () => {
  const n = node("a", { pid: 42 });
  assert.equal(joinAgents([agent("t5", 42)], [n]).get("t5"), n);
  assert.equal(joinChildren([agent("t5", 42)], [n]).get("t5"), n);
});

test("a done or closed node does not join by pid", () => {
  for (const state of ["done", "closed", "lost"]) {
    assert.equal(joinAgents([agent("t5", 42)], [node("a", { pid: 42, state })]).size, 0);
  }
});

test("a pid mismatch does not join, nor does a remote node or machine", () => {
  assert.equal(joinAgents([agent("t5", 43)], [node("a", { pid: 42 })]).size, 0);
  assert.equal(joinAgents([agent("t5", 42)], [node("a", { pid: 42, machine: "m" })]).size, 0);
  assert.equal(joinAgents([agent("m/t5", 42)], [node("a", { pid: 42 })], "m").size, 0);
});

test("an hcTerminal match wins; the pid never steals a matched node", () => {
  const n = node("a", { pid: 42, hcTerminal: "t1" });
  const got = joinAgents([agent("t1", 42), agent("t2", 42)], [n]);
  assert.equal(got.get("t1"), n);
  assert.equal(got.has("t2"), false);
});

test("one terminal per node, and a taken node is not used by joinChildren", () => {
  const n = node("a", { pid: 42 });
  assert.equal(joinAgents([agent("t1", 42), agent("t2", 42)], [n]).size, 1);
  assert.equal(joinChildren([agent("t1", 42)], [n], null, new Set([n])).size, 0);
});
