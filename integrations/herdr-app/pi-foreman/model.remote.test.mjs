import test from "node:test";
import assert from "node:assert/strict";
import { parseRadar, buildTree, nodeStatus, sessionRows } from "./model.js";

const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
// a remote child as the radar emits it (remote_glyph + the ask row)
const remote = (over = {}) => ({
  key: "c1", kind: "session", name: "demo@alpha", machine: "alpha", state: "idle", sym: "waiting", glyph: "idle", hcTerminal: null, pid: null, own: cost, tot: cost,
  children: [], waits: [], tasks: [], ...over,
});
const node = (over) => buildTree(parseRadar(JSON.stringify({ roots: [remote(over)] })))[0];

test("remote ask row: an open ask label is blocked and shows ask n", () => {
  const n = node({ state: "ask", glyph: "blocked", asks: [{ n: 3, topic: "remote" }] });
  assert.equal(nodeStatus(n), "blocked");
  assert.equal(sessionRows(n).ask, "ask 3: remote");
  assert.equal(sessionRows(n).blocked, true);
});

test("remote states from remoteLive: blocked, working, idle and finished", () => {
  assert.equal(nodeStatus(node({ state: "blocked", glyph: "blocked" })), "blocked");
  assert.equal(nodeStatus(node({ state: "working", glyph: "working" })), "working");
  assert.equal(nodeStatus(node({ state: "idle" })), "idle");
  assert.equal(nodeStatus(node({ state: "finished" })), "idle");
});
