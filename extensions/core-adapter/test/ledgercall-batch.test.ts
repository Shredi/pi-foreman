// D74: foreman_ledger add takes `texts` and upsert takes `entries`: all validated first, then applied one after another.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { LEDGER_BATCH_MAX, planLedgerCall } from "../ledgercall.ts";
import { setup } from "./_hsrig.ts";
import type { Rig } from "./_hsrig.ts";

const gate = { last: null, revised: false };
const plan = (params: Record<string, unknown>, child = false) => planLedgerCall(params, { child, gate });
const refused = (params: Record<string, unknown>, child = false): string => {
  const r = plan(params, child);
  assert.ok("error" in r, JSON.stringify(params));
  return r.error;
};

test("add: texts become one add call each, in order; text and texts together are refused", () => {
  assert.deepEqual(plan({ action: "add", texts: ["a", " b "] }), { calls: [["add", "a"], ["add", "b"]], items: "", attested: false });
  assert.match(refused({ action: "add", text: "x", texts: ["a"] }), /not both/);
});

test("add: a bad texts list refuses the whole call", () => {
  for (const texts of [[], ["a", ""], ["a", "two\nlines"], ["a", 3], "a", Array.from({ length: LEDGER_BATCH_MAX + 1 }, (_, i) => `t${i}`)]) refused({ action: "add", texts });
  assert.ok("calls" in plan({ action: "add", texts: Array.from({ length: LEDGER_BATCH_MAX }, (_, i) => `t${i}`) }));
});

test("upsert: entries become one upsert each; both forms together are refused", () => {
  assert.deepEqual(plan({ action: "upsert", entries: [{ item: 2, text: "x" }, { text: "new" }, { item: "v", text: "y" }] }), { calls: [], items: "2,V", attested: false, upserts: [{ item: "2", text: "x" }, { item: null, text: "new" }, { item: "V", text: "y" }] });
  assert.match(refused({ action: "upsert", entries: [{ text: "x" }], text: "y" }), /not both/);
  assert.match(refused({ action: "upsert", entries: [{ text: "x" }], item: 1 }), /not both/);
});

test("upsert: a malformed entry, a duplicate item or a list over the limit refuses the whole call", () => {
  const bad: unknown[] = [[], [{ item: 1 }], [{ item: "x", text: "t" }], [{ item: 1, text: "a" }, { item: "1", text: "b" }], [{ text: "two\nlines" }], [{ text: "t", extra: 1 }], ["t"], Array.from({ length: LEDGER_BATCH_MAX + 1 }, (_, i) => ({ text: `t${i}` }))];
  for (const entries of bad) refused({ action: "upsert", entries });
});

test("a reviewer child may not add or upsert in a list", () => {
  refused({ action: "add", texts: ["a", "b"] }, true);
  refused({ action: "upsert", entries: [{ item: 1, text: "a" }] }, true);
});

const call = async (a: Rig, params: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
  const r = (await a.tool("foreman_ledger")!.execute("id", params, undefined, undefined, a.ctx)) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
};
const LEDGER = "# Ledger: x\nTier: standard\n\n- [x] 1. one\n- [ ] 2. two\n- [ ] 3. three\n- [ ] V. fresh-eyes verification passed\n";

test("wiring: three texts in one call get three new numbers in order", async (t) => {
  const { a, w } = await setup(t);
  await a.writeLedger(LEDGER);
  const r = await call(a, { action: "add", texts: ["four", "five", "six"] });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /added 4: .*four\nadded 5: .*five\nadded 6: .*six\n/);
  const file = fs.readFileSync(path.join(w.project, ".workflow", "LEDGER-x.md"), "utf8");
  assert.match(file, /\] 4\. four\n[\s\S]*\] 5\. five\n[\s\S]*\] 6\. six\n/);
});

test("wiring: two upserts change both texts and keep both states; one unknown item refuses the call and changes nothing", async (t) => {
  const { a, w } = await setup(t);
  await a.writeLedger(LEDGER);
  const file = path.join(w.project, ".workflow", "LEDGER-x.md");
  const none = await call(a, { action: "upsert", entries: [{ item: 1, text: "uno" }, { item: 9, text: "nine" }] });
  assert.equal(none.isError, true);
  assert.equal(fs.readFileSync(file, "utf8"), LEDGER, "nothing was written");
  const r = await call(a, { action: "upsert", entries: [{ item: 1, text: "uno" }, { item: 2, text: "dos" }] });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /upserted 1[\s\S]*upserted 2/);
  const now = fs.readFileSync(file, "utf8");
  assert.match(now, /- \[x\] 1\. uno\n/);
  assert.match(now, /- \[ \] 2\. dos\n/);
});

test("wiring: three texts in one add call each get their own ledger add hint; a single add gets one too", async (t) => {
  const { a, w } = await setup(t);
  await a.writeLedger(LEDGER);
  const file = path.join(w.project, ".workflow", "LEDGER-x.md");
  const r = await call(a, { action: "add", texts: ["four", "five", "six"] });
  assert.equal(r.isError, false, r.text);
  const three = fs.readFileSync(file, "utf8");
  for (const n of ["4. four", "5. five", "6. six"]) {
    const word = n.slice(3);
    assert.match(three, new RegExp(`\\] ${n}\\n\\s+> \\d{4}-\\d{2}-\\d{2} ledger add: ${word}\\n`), n);
  }
  assert.equal(three.match(/ledger add: /g)?.length, 3, "one hint per new item, none bare");
  const one = await call(a, { action: "add", text: "seven" });
  assert.equal(one.isError, false, one.text);
  assert.match(fs.readFileSync(file, "utf8"), /\] 7\. seven\n\s+> \d{4}-\d{2}-\d{2} ledger add: seven\n/);
});
