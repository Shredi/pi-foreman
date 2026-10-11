import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyLedgerItems, ledgerItemsBlock } from "../ledgerblock.ts";

const LEDGER = "# L\n\nTier: standard\n\n- [ ] 1. add the parser\n- [x] 2. wire the flag\n- [ ] 3. docs\n- [ ] V. fresh-eyes verification passed\n";

test("ledgerblock: a task citing items gets exactly those lines", () => {
  const b = ledgerItemsBlock(LEDGER, "Do items 1 and 3 now");
  assert.match(b, /^\[pi-foreman ledger items\]/);
  assert.match(b, /- \[ \] 1\. add the parser\n- \[ \] 3\. docs\n\[end of ledger items\]\n$/);
  assert.doesNotMatch(b, /wire the flag/);
  assert.match(ledgerItemsBlock(LEDGER, "fix #2"), /- \[x\] 2\. wire the flag/);
});

test("ledgerblock: no citation, no ledger or an unknown item gives no block", () => {
  assert.equal(ledgerItemsBlock(LEDGER, "implement the parser"), "");
  assert.equal(ledgerItemsBlock(null, "item 1"), "");
  assert.equal(ledgerItemsBlock(LEDGER, "item 9"), "");
});

test("ledgerblock: builder steps only, resume and skipped entries untouched", () => {
  const single = { agent: "builder", task: "item 1" };
  const exp = { agent: "explorer", task: "item 1" };
  const skipped = { agent: "builder", task: "item 3" };
  const input = { tasks: [single, exp, skipped] };
  const recs = applyLedgerItems(input, LEDGER, new Set([skipped]));
  assert.equal(recs.length, 1);
  assert.match(single.task, /^\[pi-foreman ledger items\][\s\S]*add the parser[\s\S]*\nitem 1$/);
  assert.equal(exp.task, "item 1");
  assert.equal(skipped.task, "item 3");
  const resume = { action: "resume", agent: "builder", task: "item 1" };
  assert.deepEqual(applyLedgerItems(resume, LEDGER), []);
  assert.equal(resume.task, "item 1");
});

test("ledgerblock: reviewers get the cited items, else the whole ledger; cwd = a worktree does not matter", () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "fm-wt-"));
  try {
    const cited = { agent: "reviewer", task: "review item 1", cwd: wt };
    const whole = { agent: "senior-reviewer", task: "review the diff", cwd: wt };
    const recs = applyLedgerItems({ tasks: [cited, whole] }, LEDGER);
    assert.deepEqual(recs.map((r) => r.role), ["reviewer", "senior-reviewer"]);
    assert.match(cited.task, /^\[pi-foreman ledger items\][\s\S]*1\. add the parser[\s\S]*\nreview item 1$/);
    assert.doesNotMatch(cited.task, /wire the flag/);
    assert.match(whole.task, /^\[pi-foreman ledger\][\s\S]*# L\n\nTier: standard\n\n- \[ \] 1\. add the parser\n- \[x\] 2\. wire the flag[\s\S]*\[end of ledger\]\nreview the diff$/);
    const none = { agent: "reviewer", task: "review" };
    assert.deepEqual(applyLedgerItems(none, null), []);
    assert.equal(none.task, "review");
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
  }
});
