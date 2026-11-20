import test from "node:test";
import assert from "node:assert/strict";
import { sessionTree, restartChild, hcChildItems } from "./model.js";
import { sess, treeOf } from "./fixtures.mjs";

const kids = (t) => t.children.filter((c) => c.type === "session");
const ended = (key, over = {}) => sess(key, key, { state: "closed", sym: "done", restartable: true, child: `fm-${key}-1`, ...over });

test("an ended child radar flagged restartable keeps its row, dimmed, with the child id as its restart", () => {
  const t = sessionTree(treeOf(sess("r", "r", {}, [ended("old")])));
  const [row] = kids(t);
  assert.equal(row.label, "old");
  assert.equal(row.dim, true);
  assert.equal(row.restart, "fm-old-1");
});

test("an ended child without the flag is dropped as before; a live one has no restart", () => {
  const t = sessionTree(treeOf(sess("r", "r", {}, [ended("old", { restartable: false }), sess("live", "live", { hcTerminal: "t1", restartable: true, child: "fm-live-1" })])));
  assert.deepEqual(kids(t).map((c) => c.label), ["live"]);
  assert.equal(kids(t)[0].restart, undefined);
});

test("a remote child that finished is restartable; a lost one with an open entry or a live terminal is not ended and gets none", () => {
  const fin = sessionTree(treeOf(sess("r", "r", {}, [ended("fin", { state: "finished", machine: "alpha", hcTerminal: "alpha/t7" })])));
  assert.equal(kids(fin)[0].restart, "fm-fin-1");
  for (const over of [{ regOpen: true }]) {
    const lost = sessionTree(treeOf(sess("r", "r", {}, [ended("lost", { state: "lost", machine: "alpha", hcTerminal: "alpha/t7", ...over })])));
    assert.equal(kids(lost)[0].restart, undefined, JSON.stringify(over));
  }
  assert.equal(restartChild({ restartable: true, child: "x", state: "lost", regOpen: true }), "");
  assert.equal(restartChild({ restartable: true, child: "x", state: "lost", liveHc: true }), "", "the render sets liveHc for a live terminal");
  assert.equal(restartChild({ restartable: true, child: "x", state: "finished" }), "x");
});

test("the remote machine's own card (no flag from radar) has no restart even when ended", () => {
  const t = sessionTree(treeOf(sess("r", "r", {}, [ended("own", { restartable: undefined })])));
  assert.deepEqual(kids(t), []);
});

test("an ended restartable child joined to a hc terminal keeps its row with the restart", () => {
  const node = treeOf(ended("old", { hcTerminal: "t5" }));
  const items = hcChildItems([{ address: "t5", parent: "p", state: "live", name: "n" }], "p", () => ({ node, status: "idle" }));
  assert.equal(items[0].restart, "fm-old-1");
  const plain = hcChildItems([{ address: "t5", parent: "p", state: "live", name: "n" }], "p", () => ({ node: treeOf(ended("old", { hcTerminal: "t5", restartable: false })), status: "idle" }));
  assert.deepEqual(plain, []);
});
