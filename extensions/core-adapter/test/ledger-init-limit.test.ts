import { test } from "node:test";
import assert from "node:assert/strict";
import { ITEM_LINE_MAX, planLedgerInit } from "../ledgercall.ts";

test("D224: init refuses an item text that takes its line over the limit, with the file hint", () => {
  const r = planLedgerInit({ topic: "t1", texts: ["short", "x".repeat(ITEM_LINE_MAX)] });
  assert.ok("error" in r);
  assert.match(r.error, /item 2 would be \d+ characters, over the limit of 1000/);
  assert.match(r.error, /keep evidence in a file and link it/);
});

test("D224: init accepts texts within the limit", () => {
  const r = planLedgerInit({ topic: "t1", texts: ["short", "y".repeat(900)] });
  assert.ok(!("error" in r));
});
