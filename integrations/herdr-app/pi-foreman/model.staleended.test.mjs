import test from "node:test";
import assert from "node:assert/strict";
import { sessionTree, isEnded, sessionCount } from "./model.js";
import { sess, treeOf } from "./fixtures.mjs";

const labels = (t) => t.children.filter((c) => c.type === "session").map((c) => c.label);
const under = (over) => treeOf(sess("r", "r", {}, [sess("a", "a", { state: "stale", ...over }), sess("c", "c", { hcTerminal: "t1" })]));

test("a stale child without a live terminal is ended and dropped like a lost one", () => {
  assert.equal(isEnded({ state: "stale" }), true);
  assert.deepEqual(labels(sessionTree(under({}))), ["c"]);
  assert.deepEqual(labels(sessionTree(under({}))), labels(sessionTree(treeOf(sess("r", "r", {}, [sess("a", "a", { state: "lost" }), sess("c", "c", { hcTerminal: "t1" })])))));
  assert.equal(sessionCount(treeOf(sess("r", "r", {}, [sess("a", "a", { state: "stale" })]))), 1);
});

test("a stale child with a live terminal or an open registry entry stays", () => {
  assert.equal(isEnded({ state: "stale", liveHc: true }), false);
  assert.equal(isEnded({ state: "stale", regOpen: true }), false);
  assert.deepEqual(labels(sessionTree(under({ regOpen: true }))).sort(), ["a", "c"]);
});
