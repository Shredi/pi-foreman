import test from "node:test";
import assert from "node:assert/strict";
import { sessionTree, displayStatus, hcChildItems } from "./model.js";
import { sess, run, treeOf } from "./fixtures.mjs";

const closed = (key, over = {}, kids = []) => sess(key, key, { state: "closed", sym: "done", ...over }, kids);
const sessions = (t) => t.children.filter((c) => c.type === "session");

test("closed child sessions and their agents are dropped", () => {
  const t = sessionTree(treeOf(sess("r", "r", {}, [sess("live", "live", { hcTerminal: "t1" }), closed("old", {}, [run("x", "builder", { state: "done", sym: "done" })])])));
  assert.deepEqual(sessions(t).map((c) => c.label), ["live"]);
});

test("a closed parent with a live child stays, dimmed, without agents", () => {
  const t = sessionTree(treeOf(sess("r", "r", {}, [closed("p", {}, [run("x", "builder"), sess("kid", "kid", { state: "working", sym: "working" })])])));
  const p = sessions(t)[0];
  assert.equal(p.label, "p");
  assert.equal(p.dim, true);
  assert.deepEqual(p.children.map((c) => c.label), ["kid"]);
  assert.equal(p.status, "idle");
});

test("closed sessions do not raise the rank or the folded glyph", () => {
  const t = sessionTree(treeOf(sess("r", "r", {}, [closed("old", {}, [run("x", "builder")])])));
  assert.equal(t.children.length, 0);
  assert.equal(t.urgent, "idle");
  assert.equal(displayStatus(t, new Set([t.id])), "idle");
  const p = sessionTree(treeOf(sess("r", "r", {}, [closed("p", { state: "closed" }, [sess("kid", "kid", { sym: "waiting-external", waits: [{ kind: "ci", note: "ci", age_s: 1 }] })])])));
  assert.equal(sessions(p)[0].status, "idle");
  assert.equal(sessions(p)[0].urgent, "waiting");
});

test("a terminal-less row gets the elsewhere tag; a remote row its machine", () => {
  const t = sessionTree(treeOf(sess("r", "r", {}, [sess("a", "a"), sess("b", "b", { machine: "mini", hcTerminal: "t9" })])));
  const by = Object.fromEntries(sessions(t).map((c) => [c.label, c.elsewhere]));
  assert.deepEqual(by, { a: "elsewhere", b: "mini" });
});

test("a clickable row carries no tag", () => {
  const t = sessionTree(treeOf(sess("r", "r", {}, [sess("a", "a", { hcTerminal: "t1" })])));
  assert.equal(t.elsewhere, "");
  assert.equal(sessions(t)[0].elsewhere, "");
  const kids = hcChildItems([{ address: "t1", parent: "p", state: "live", name: "n" }], "p", () => ({ node: treeOf(sess("a", "a")), status: "idle" }));
  assert.equal(kids[0].elsewhere, "");
  assert.equal(kids[0].address, "t1");
});
