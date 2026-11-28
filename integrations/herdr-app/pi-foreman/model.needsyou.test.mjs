import test from "node:test";
import assert from "node:assert/strict";
import { NEEDS_YOU, BUSY, needsYou, blockNeedsYou } from "./model.js";

const item = (status, children = []) => ({ status, urgent: status, children });

test("needsYou: blocked, idle and done are shown, busy statuses are not", () => {
  for (const s of NEEDS_YOU) assert.equal(needsYou(s), true, s);
  for (const s of BUSY) assert.equal(needsYou(s), false, s);
});

test("needsYou: an unknown status is shown", () => {
  assert.equal(needsYou("unknown"), true);
  assert.equal(needsYou(undefined), true);
});

test("blockNeedsYou: a busy block without items is hidden, a non-busy one shown", () => {
  assert.equal(blockNeedsYou("working", []), false);
  assert.equal(blockNeedsYou("idle", []), true);
  assert.equal(blockNeedsYou("blocked", undefined), true);
});

test("blockNeedsYou: a blocked child session or agent keeps a busy parent, also deep", () => {
  assert.equal(blockNeedsYou("working", [item("blocked")]), true);
  assert.equal(blockNeedsYou("waiting", [item("working", [item("agents", [item("blocked")])])]), true);
});

test("blockNeedsYou: a blocked item next to a hidden sibling keeps the parent (urgent would mask it)", () => {
  assert.equal(blockNeedsYou("working", [item("hidden"), item("blocked")]), true);
});

test("blockNeedsYou: idle and done children do not keep a busy parent", () => {
  assert.equal(blockNeedsYou("working", [item("idle"), item("done"), item("working")]), false);
  assert.equal(blockNeedsYou("bg", [item("done", [item("idle")])]), false);
});
