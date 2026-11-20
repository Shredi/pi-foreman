import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, buildTree, restartChild } from "./model.js";

const doc = JSON.stringify({ roots: [{ key: "r", kind: "session", name: "r", state: "open", children: [
  { key: "old", kind: "session", name: "old", state: "closed", restartable: true, child: "fm-old-1" }] }] });
const ended = (tree) => tree[0].children[0];

test("an ended restartable child of the local tree has a restart; one of a remote machine's own tree has none", () => {
  assert.equal(restartChild(ended(buildTree(parseRadarDoc(doc).nodes))), "fm-old-1");
  assert.equal(restartChild(ended(buildTree(parseRadarDoc(doc, "beta").nodes))), "");
});
