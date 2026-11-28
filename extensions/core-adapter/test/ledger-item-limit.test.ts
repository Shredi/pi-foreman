import { test } from "node:test";
import assert from "node:assert/strict";
import { ITEM_LINE_MAX, itemLineLength, rewriteItemText } from "../ledgercall.ts";

const ledger = (text: string): string => `# Ledger\n- [ ] 1. ${text}\n- [ ] V. verify\n`;

test("D224: an upsert that takes an item line over the limit is refused with the file hint", () => {
  const r = rewriteItemText(ledger("short"), "1", "x".repeat(ITEM_LINE_MAX));
  assert.ok("error" in r);
  assert.match(r.error, /over the limit of 1000/);
  assert.match(r.error, /keep evidence in a file and link it/);
});

test("D224: an upsert within the limit passes", () => {
  const r = rewriteItemText(ledger("short"), "1", "y".repeat(900));
  assert.ok(!("error" in r) && r.changed);
});

test("D224: only growth is refused: an over-limit item may be shortened", () => {
  const long = ledger("z".repeat(1500));
  const r = rewriteItemText(long, "1", "z".repeat(1200));
  assert.ok(!("error" in r) && r.changed);
  const grow = rewriteItemText(long, "1", "z".repeat(1600));
  assert.ok("error" in grow);
});

test("D224: itemLineLength is the line without its break; null for an unknown item", () => {
  const f = ledger("abc");
  assert.equal(itemLineLength(f, "1"), "- [ ] 1. abc".length);
  assert.equal(itemLineLength(f, "9"), null);
});
