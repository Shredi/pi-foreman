// R26 item 4: a builder brief says the foreman stages and commits a protected (write-ask) path once; an explorer or reviewer brief does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLedgerItems } from "../ledgerblock.ts";

const LINE = "Protected files (";
const ledger = "- [ ] 1. do a thing\n";

test("r26 protected hint: the builder brief carries the line, an explorer and a reviewer brief do not", () => {
  const brief = (agent: string, task: string) => {
    const input: Record<string, unknown> = { agent, task };
    applyLedgerItems(input, ledger);
    return input.task as string;
  };
  assert.ok(brief("builder", "implement item 1").includes(LINE));
  assert.ok(brief("builder", "implement the thing").includes(LINE), "also without a cited item");
  assert.ok(!brief("explorer", "look at item 1").includes(LINE));
  assert.ok(!brief("reviewer", "review item 1").includes(LINE));
});
