// One reviewer per revision: which changes since a PASS allow another reviewer launch (bound.ts repeatSignals).
import { test } from "node:test";
import assert from "node:assert/strict";
import { dupRefusalText, repeatSignals, type PassMark } from "../bound.ts";

const mark: PassMark = { at: 1, head: "h1", tree: "t1", ledger: "/l/LEDGER-a.md", builderRuns: 1 };
const same = { head: "h1", tree: "t1", ledger: "/l/LEDGER-a.md", builderRuns: 1 };

test("repeatSignals: nothing changed -> no signal (refused)", () => {
  assert.deepEqual(repeatSignals(mark, same), []);
  assert.deepEqual(repeatSignals({ ...mark, head: null, tree: null, ledger: null }, { ...same, head: null, tree: null, ledger: null }), [], "null on both sides is unchanged");
});

test("repeatSignals: each signal alone allows a repeat", () => {
  assert.deepEqual(repeatSignals(mark, { ...same, builderRuns: 2 }), ["builder"]);
  assert.deepEqual(repeatSignals(mark, { ...same, head: "h2" }), ["head"]);
  assert.deepEqual(repeatSignals(mark, { ...same, tree: "t2" }), ["tree"], "a new untracked file or a tracked edit changes the worktree tree");
  assert.deepEqual(repeatSignals(mark, { ...same, ledger: "/l/LEDGER-b.md" }), ["ledger"]);
  assert.deepEqual(repeatSignals(mark, { ...same, ledger: null }), ["ledger"]);
});

test("dupRefusalText names what was compared and when", () => {
  const text = dupRefusalText(new Date(2026, 0, 1, 13, 4, 5).getTime());
  assert.match(text, /passed at 13:04:05 and nothing changed since \(no builder run, HEAD, worktree or ledger change\)/);
  assert.match(text, /\[second-opinion\]/);
});
