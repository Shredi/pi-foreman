// The steward instruction's ledger step: the way out for a bound ledger whose items are all closed, and no branch the tools never reach.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const INSTRUCTION = fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "..", "instructions", "steward.md"), "utf8");

test("step 1 tells the steward to add the standing item when every item of a bound ledger is closed", () => {
  assert.match(INSTRUCTION, /items are all closed[^.]*add the standing item with `foreman_ledger` action `add`/);
});

test("step 1 has no ledger_bound_elsewhere branch", () => {
  assert.ok(!INSTRUCTION.includes("ledger_bound_elsewhere"));
});
