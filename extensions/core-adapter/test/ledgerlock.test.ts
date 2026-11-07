import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LedgerGate } from "../ledgerlock.ts";
import { writeHint } from "../hints.ts";

function ledger(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerlock-"));
  const f = path.join(dir, "LEDGER-x.md");
  fs.writeFileSync(f, "# Ledger\n\n- [ ] 1. one\n- [ ] 2. two\n");
  return f;
}

/** What a `ledger mark N` child does: read at start, replace at the end. */
function childMark(f: string, n: number): { finish: () => void } {
  const before = fs.readFileSync(f, "utf8");
  return { finish: () => fs.writeFileSync(f, before.replace(new RegExp(`\\[ \\] ${n}\\.`), `[x] ${n}.`)) };
}

test("a hint requested while a ledger bash holds the gate is applied after it; mark and hint both survive", () => {
  const f = ledger();
  const g = new LedgerGate();
  g.hold("call-1");
  const child = childMark(f, 2);
  g.defer(() => void writeHint(f, ["2"], "review PASS"));
  assert.ok(!fs.readFileSync(f, "utf8").includes("review PASS"), "deferred, not written yet");
  child.finish();
  g.release("call-1");
  const out = fs.readFileSync(f, "utf8");
  assert.match(out, /\[x\] 2\./);
  assert.match(out, /review PASS/);
});

test("without the gate the same interleaving loses the mark (the bug)", () => {
  const f = ledger();
  const child = childMark(f, 2);
  writeHint(f, ["2"], "review PASS");
  child.finish();
  assert.ok(!fs.readFileSync(f, "utf8").includes("review PASS"));
});

test("no ledger call in flight: a hint is written immediately", () => {
  const f = ledger();
  const g = new LedgerGate();
  g.defer(() => void writeHint(f, ["1"], "launched"));
  assert.match(fs.readFileSync(f, "utf8"), /launched/);
});

test("release on timeout frees the lock and applies the deferred hint", async () => {
  const f = ledger();
  const g = new LedgerGate(20);
  g.hold("lost");
  g.defer(() => void writeHint(f, ["1"], "late hint"));
  assert.ok(!fs.readFileSync(f, "utf8").includes("late hint"));
  await new Promise((r) => setTimeout(r, 80));
  assert.match(fs.readFileSync(f, "utf8"), /late hint/);
});

test("releaseAll frees held calls (session shutdown / blocked call)", () => {
  const f = ledger();
  const g = new LedgerGate();
  g.hold("s1:a");
  g.hold("s1:b");
  g.defer(() => void writeHint(f, ["1"], "after shutdown"));
  g.release("s1:a");
  assert.ok(!fs.readFileSync(f, "utf8").includes("after shutdown"), "still held by b");
  g.releaseAll("s1:");
  assert.match(fs.readFileSync(f, "utf8"), /after shutdown/);
});

test("exclusive waits for a hold, then runs; a deferred hint lands after the exclusive run", async () => {
  const f = ledger();
  const g = new LedgerGate();
  g.hold("c");
  const order: string[] = [];
  const ex = g.exclusive(async () => {
    order.push("run");
    const child = childMark(f, 1);
    await new Promise((r) => setTimeout(r, 5));
    g.defer(() => void writeHint(f, ["1"], "hint during run"));
    child.finish();
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, [], "waits for the hold");
  g.release("c");
  await ex;
  const out = fs.readFileSync(f, "utf8");
  assert.deepEqual(order, ["run"]);
  assert.match(out, /\[x\] 1\./);
  assert.match(out, /hint during run/);
});

test("exclusive releases when fn throws; no deadlock afterwards", async () => {
  const g = new LedgerGate();
  await assert.rejects(g.exclusive(() => Promise.reject(new Error("boom"))), /boom/);
  assert.equal(await g.exclusive(() => 7), 7);
});

test("exclusive runs never overlap", async () => {
  const g = new LedgerGate();
  let inside = 0;
  let max = 0;
  const run = () => g.exclusive(async () => {
    max = Math.max(max, ++inside);
    await new Promise((r) => setTimeout(r, 5));
    inside--;
  });
  await Promise.all([run(), run(), run()]);
  assert.equal(max, 1);
});
