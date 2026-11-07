import { test } from "node:test";
import assert from "node:assert/strict";
import { retryLedgerRun } from "../ledgercall.ts";

type R = { code: number; stdout: string; stderr: string };
const denied: R = { code: 1, stdout: "", stderr: "PermissionError: [WinError 5] Access is denied" };
const ok: R = { code: 0, stdout: "ok", stderr: "" };

function fake(results: R[]) {
  let runs = 0;
  const sleeps: number[] = [];
  return {
    run: async () => results[Math.min(runs++, results.length - 1)]!,
    sleep: async (ms: number) => void sleeps.push(ms),
    get runs() { return runs; },
    sleeps,
  };
}

test("two access-denied failures then success -> success after 3 runs", async () => {
  const f = fake([denied, denied, ok]);
  assert.equal(await retryLedgerRun(f.run, f.sleep), ok);
  assert.equal(f.runs, 3);
});

test("persistent access-denied failure -> last failure after the bound", async () => {
  const f = fake([denied]);
  assert.equal(await retryLedgerRun(f.run, f.sleep), denied);
  assert.equal(f.runs, 10);
  assert.ok(f.sleeps.every((ms) => ms <= 200));
});

test("ordinary refusal -> exactly one run", async () => {
  const refusal: R = { code: 1, stdout: "", stderr: "ledger: refused" };
  const f = fake([refusal]);
  assert.equal(await retryLedgerRun(f.run, f.sleep), refusal);
  assert.equal(f.runs, 1);
});
