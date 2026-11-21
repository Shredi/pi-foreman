import test from "node:test";
import assert from "node:assert/strict";
import { sessionTree, nodeStatus, isEnded, staleMinutes } from "./model.js";
import { sess, treeOf } from "./fixtures.mjs";

const remote = (over = {}) => sess("c1", "demo@box1", { machine: "box1", hcTerminal: "box1/t1", state: "working", sym: "working", parent: "p", ...over });
const rows = (kid) => sessionTree(treeOf(sess("p", "parent", { hcTerminal: "t1" }, [kid])), { id: "p" }).children;

test("a remote node with remoteStale draws `stale <m>m` in place and keeps its row", () => {
  const kid = remote({ remoteStale: 250 });
  const [row] = rows(kid);
  assert.equal(row.elsewhere, "box1 · stale 4m");
  assert.equal(row.dim, false);
  assert.equal(isEnded(row.node), false);
  assert.equal(row.status, "idle");
});

test("without remoteStale the row is as before", () => {
  const [row] = rows(remote());
  assert.equal(row.elsewhere, "box1");
  assert.equal(row.status, "working");
  assert.equal(staleMinutes(row.node), 0);
});

test("an open ask still wins over the stale marker", () => {
  assert.equal(nodeStatus({ ...remote({ remoteStale: 250 }), state: "ask" }), "blocked");
});
