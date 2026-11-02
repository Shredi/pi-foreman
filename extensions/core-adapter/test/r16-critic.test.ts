// R16 item 6 (P3): review.critic is rendered into every reviewer task, not into builder or explorer tasks;
// an override replaces the list, an empty list renders nothing. The harness does not parse the CRITIC lines (ruling D4).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { applyLedgerItems, criticBlock, criticOf } from "../ledgerblock.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEFAULTS = JSON.parse(fs.readFileSync(path.join(PKG, "config", "foreman.defaults.json"), "utf8")) as { review: { critic: string[] } };
const SCHEMA = JSON.parse(fs.readFileSync(path.join(PKG, "config", "foreman.schema.json"), "utf8")) as { properties: { review: { properties: Record<string, { type: string }> } } };
const CRITIC = DEFAULTS.review.critic;
const LEDGER = "# L\n\n- [ ] 1. add the parser\n- [ ] 2. wire the flag\n";

test("r16 critic: the default is the four owner questions and the schema knows the key", () => {
  assert.equal(CRITIC.length, 4);
  assert.match(CRITIC[0], /^\(1\) Is this lean/);
  assert.match(CRITIC[2], /an item failing this is dropped, not built/);
  assert.match(CRITIC[3], /Pi top-chair switch/);
  assert.equal(SCHEMA.properties.review.properties.critic.type, "array");
});

test("r16 critic: reviewer tasks, cited or not, get the block after the ledger items, builder and explorer none", () => {
  const rev = { agent: "reviewer", task: "review item 1" };
  const sen = { agent: "reviewer", task: "plan review" };
  const bld = { agent: "builder", task: "item 2" };
  const exp = { agent: "explorer", task: "look at item 1" };
  applyLedgerItems({ tasks: [rev, sen, bld, exp] }, LEDGER, new Set(), null, CRITIC);
  for (const t of [rev.task, sen.task]) {
    assert.match(t, /\[pi-foreman critic\] Answer each question once per ledger item as a line `CRITIC: <item> Q<k>: <answer>`\./);
    for (const [i, q] of CRITIC.entries()) assert.ok(t.includes(`Q${i + 1}. ${q.replace(/^\(\d\) /, "")}`), q);
  }
  assert.match(rev.task, /^\[pi-foreman ledger items\][\s\S]*\[end of ledger items\]\n\[pi-foreman critic\][\s\S]*\[end of critic\]\nreview item 1$/);
  assert.match(sen.task, /^\[pi-foreman ledger\][\s\S]*\[end of ledger\]\n\[pi-foreman critic\]/);
  assert.doesNotMatch(bld.task, /critic/i);
  assert.equal(exp.task, "look at item 1");
});

test("r16 critic: a reviewer without a ledger and a skipped (rung-up) reviewer still get the block; a resume does not", () => {
  const noLedger = { agent: "reviewer", task: "review" };
  const skipped = { agent: "reviewer", task: "review item 1" };
  applyLedgerItems({ tasks: [noLedger, skipped] }, null, new Set([skipped]), null, CRITIC);
  assert.match(noLedger.task, /^\[pi-foreman critic\]/);
  assert.match(skipped.task, /^\[pi-foreman critic\][\s\S]*\nreview item 1$/);
  const resume = { action: "resume", agent: "reviewer", task: "go on" };
  applyLedgerItems(resume, LEDGER, new Set(), null, CRITIC);
  assert.equal(resume.task, "go on");
});

test("r16 critic: an override replaces the questions, an empty list renders no block", () => {
  const a = { agent: "reviewer", task: "review item 1" };
  applyLedgerItems(a, LEDGER, new Set(), null, ["Is it small?"]);
  assert.match(a.task, /Q1\. Is it small\?\n\[end of critic\]/);
  assert.doesNotMatch(a.task, /top-chair/);
  const b = { agent: "reviewer", task: "review item 1" };
  applyLedgerItems(b, LEDGER, new Set(), null, []);
  assert.doesNotMatch(b.task, /critic/i);
  assert.equal(criticBlock([]), "");
  const c = { agent: "reviewer", task: "review" };
  applyLedgerItems(c, null, new Set(), null, []);
  assert.equal(c.task, "review");
});

test("r16 critic: criticOf keeps non-empty strings, anything else is no questions", () => {
  assert.deepEqual(criticOf(["a", "", 3, " "]), ["a"]);
  assert.deepEqual(criticOf(undefined), []);
  assert.deepEqual(criticOf("x"), []);
});
