import test from "node:test";
import assert from "node:assert/strict";
import { buildTree, joinChildren, childTerminals, shownNodes, checkTone } from "./model.js";

test("check tone: pending is amber, fail red, ok green, the rest dim", () => {
  assert.equal(checkTone("pending"), "warning");
  assert.equal(checkTone("fail"), "fail");
  assert.equal(checkTone("ok"), "ok");
  assert.equal(checkTone("none"), "dim");
  assert.equal(checkTone(undefined), "dim");
});

test("a child whose parent terminal exited is not drawn, so its node is not joined or skipped", () => {
  const node = { key: "o", kind: "session", name: "o", hcTerminal: "t20", state: "working", sym: "", pid: null, machine: "", parent: "", waits: [], tasks: [], asks: [], prs: [], children: [], cost: 0 };
  const tree = buildTree([node]);
  const all = [
    { address: "t1", state: "live" },
    { address: "t19", parent: "t1", state: "exited" },
    { address: "t20", parent: "t19", state: "live" },
  ];
  const drawn = childTerminals(all, "t1").map((r) => r.term);
  assert.equal(drawn.length, 0);
  const joined = joinChildren(drawn, tree);
  assert.equal(joined.size, 0);
  assert.equal(shownNodes(joined).size, 0);
});
