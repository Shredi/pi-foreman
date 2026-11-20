import test from "node:test";
import assert from "node:assert/strict";
import { nodeStatus } from "./model.js";

const remote = (over) => ({ key: "k", kind: "session", name: "n", machine: "box1", state: "blocked", sym: "blocked", ...over });

test("a remote child blocked on a person is blocked although its attach terminal reports working", () => {
  assert.equal(nodeStatus(remote(), "working"), "blocked");
  assert.equal(nodeStatus(remote({ state: "working", sym: "working" }), "working"), "working");
});

test("a local node keeps hc's working over a blocked radar state", () => {
  assert.equal(nodeStatus(remote({ machine: "" }), "working"), "working");
});
