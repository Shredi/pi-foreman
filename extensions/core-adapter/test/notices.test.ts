import { test } from "node:test";
import assert from "node:assert/strict";
import { AttentionNotices } from "../notices.ts";

test("notices: the first notice for a (run, state) is shown, a duplicate is dropped", () => {
  const n = new AttentionNotices();
  assert.equal(n.admit("r1", "needs_attention"), true);
  assert.equal(n.admit("r1", "needs_attention"), false);
  assert.equal(n.admit("r1", "active_long_running"), true);
  assert.equal(n.admit("r2", "needs_attention"), true);
});

test("notices: a notice after the run's end event is dropped, other runs are unaffected", () => {
  const n = new AttentionNotices();
  n.onRunEnd("r1");
  assert.equal(n.admit("r1", "needs_attention"), false);
  assert.equal(n.admit("r2", "needs_attention"), true);
});
