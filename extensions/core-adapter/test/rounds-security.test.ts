import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLaunch, hasSecurityFinding, initialRounds, onReviewDone, type RoundState } from "../rounds.ts";

const CFG = { standard: 1, heavy: 2 };
const B = [["builder"]];

/** A built tree whose latest review FAILed (with or without a SECURITY: finding). */
const failed = (security: boolean, extra: Partial<RoundState> = {}): RoundState => ({ ...onReviewDone({ ...initialRounds(), built: true, reviewOpen: true }, "fail", security), ...extra });

test("security finding: a line starting SECURITY: (list marker or bold allowed)", () => {
  assert.equal(hasSecurityFinding("VERDICT: FAIL\nSECURITY: src/a.ts:3 path traversal"), true);
  assert.equal(hasSecurityFinding("2. Defects\n- SECURITY: x"), true);
  assert.equal(hasSecurityFinding("  **SECURITY:** x"), true);
  assert.equal(hasSecurityFinding("this is not a SECURITY: line"), false);
  assert.equal(hasSecurityFinding("security: lowercase"), false);
});

test("revision cap: a revision answering a SECURITY FAIL is exempt and does not use the limit", () => {
  const r = checkLaunch(failed(true), B, "heavy", CFG);
  assert.equal(r.block, undefined);
  assert.equal(r.revisions, 1);
  assert.equal(r.exempt, 1);
  assert.equal(r.next.used, 0);
  assert.equal(r.next.exempt, 1);
});

test("revision cap: a FAIL without SECURITY: counts as today", () => {
  const r = checkLaunch(failed(false), B, "heavy", CFG);
  assert.equal(r.exempt, undefined);
  assert.equal(r.next.used, 1);
});

test("revision cap: the next verdict ends the exemption", () => {
  const s = onReviewDone(failed(true), "fail", false);
  assert.ok(!s.secOpen);
  assert.equal(checkLaunch(s, B, "heavy", CFG).next.used, 1);
  assert.equal(checkLaunch(onReviewDone(failed(true), "pass"), B, "heavy", CFG).revisions, 0);
});

test("revision cap: exempt revisions leave the counted ones available (standard limit 1)", () => {
  let s = failed(true);
  const first = checkLaunch(s, B, "standard", CFG);
  assert.equal(first.block, undefined);
  s = onReviewDone(first.next, "fail", false); // the revision's review fails without SECURITY
  const second = checkLaunch(s, B, "standard", CFG);
  assert.equal(second.block, undefined, "one counted revision still fits the limit of 1");
  assert.equal(second.next.used, 1);
});

test("revision cap: exempt + counted never exceed 2 x the limit (heavy: 4)", () => {
  let s = failed(true);
  for (let i = 0; i < 4; i++) {
    const r = checkLaunch(s, B, "heavy", CFG);
    assert.equal(r.block, undefined, `revision ${i + 1}`);
    s = onReviewDone(r.next, "fail", true);
  }
  const over = checkLaunch(s, B, "heavy", CFG);
  assert.match(over.block ?? "", /revision ceiling for heavy reached \(4\)/);
  assert.match(over.block ?? "", /5 revision\(s\) answering a SECURITY finding/);
});

test("revision cap: mixed exempt and counted revisions stop at the ceiling", () => {
  let s = failed(false);
  for (const sec of [false, true, true]) {
    const r = checkLaunch(s, B, "heavy", CFG);
    assert.equal(r.block, undefined);
    s = onReviewDone(r.next, "fail", sec);
  }
  // 2 counted + 1 exempt so far? the first was counted (1), the second counted (2)? check totals instead
  const total = (x: RoundState): number => x.used + (x.exempt ?? 0);
  assert.equal(total(s), 3);
  const r4 = checkLaunch(s, B, "heavy", CFG);
  assert.equal(r4.block, undefined);
  assert.equal(total(r4.next), 4);
  assert.ok(checkLaunch(onReviewDone(r4.next, "fail", true), B, "heavy", CFG).block);
});

test("revision cap: trivial has limit 0, so no security exemption either", () => {
  assert.ok(checkLaunch(failed(true), B, "trivial", CFG).block);
});

test("revision cap: a chain builder after a second review in the same call is not exempt", () => {
  const r = checkLaunch(failed(true), [["builder"], ["reviewer"], ["builder"]], "heavy", CFG);
  assert.equal(r.exempt, 1);
  assert.equal(r.next.used, 1);
});
