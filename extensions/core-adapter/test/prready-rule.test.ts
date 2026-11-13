import { test } from "node:test";
import assert from "node:assert/strict";
import { readiness, reviewFactsOf } from "../prready.ts";
import type { RuleInput } from "../prready.ts";
import { reviewsOfEntry } from "../reviews.ts";
import type { ReviewRecord } from "../reviews.ts";
import { buildCeremonyState } from "../planstate.ts";

const H = "a".repeat(40);
const G = "b".repeat(40);
const rec = (o: Partial<ReviewRecord> = {}): ReviewRecord => ({ role: "reviewer", verdict: "pass", head: H, kind: "code", occasion: "pre-pr", ...o });

test("review facts: a [pre-pr] PASS on the host head, no revision, no send-back is ok", () => {
  assert.equal(reviewFactsOf([rec()], H, false, false), "ok");
});

test("review facts: an item review PASS on the head is not enough", () => {
  assert.equal(reviewFactsOf([rec({ occasion: "item" })], H, false, false), "unreviewed");
});

test("review facts: a record without an occasion is not a [pre-pr] PASS", () => {
  const { occasion: _o, ...bare } = rec();
  assert.equal(reviewFactsOf([bare], H, false, false), "unreviewed");
});

test("review facts: every fact on its own breaks it (revised, sent back, another head, no head, no record)", () => {
  assert.equal(reviewFactsOf([rec()], H, true, false), "wip");
  assert.equal(reviewFactsOf([rec()], H, false, true), "wip");
  assert.equal(reviewFactsOf([rec()], G, false, false), "unreviewed");
  assert.equal(reviewFactsOf([rec()], "", false, false), "unreviewed");
  assert.equal(reviewFactsOf([], H, false, false), "unreviewed");
  assert.equal(reviewFactsOf([rec({ head: null })], H, false, false), "unreviewed");
});

test("review facts: the newest record FAIL is work in progress even with an older PASS on the same head", () => {
  assert.equal(reviewFactsOf([rec(), rec({ verdict: "fail" })], H, false, false), "wip");
});

test("review facts: an item PASS after a [pre-pr] PASS, with work in between, does not make it ready", () => {
  // the work in between: revised was set; the later item PASS clears it, but the newest record is not a [pre-pr] PASS
  assert.equal(reviewFactsOf([rec(), rec({ occasion: "item" })], H, false, false), "unreviewed");
  assert.equal(reviewFactsOf([rec(), rec({ occasion: "item" })], H, true, false), "wip");
});

test("review facts: a plan review never counts, before or after the PASS", () => {
  assert.equal(reviewFactsOf([rec(), rec({ kind: "plan", head: null, verdict: "fail", occasion: undefined })], H, false, false), "ok");
  assert.equal(reviewFactsOf([rec({ kind: "plan", head: null })], H, false, false), "unreviewed");
});

const base: RuleInput = { facts: "ok", checks: "green", mergeable: true, mergeState: "clean", draft: false };

test("readiness table: each fact true and false", () => {
  assert.deepEqual(readiness(base), { result: "ready", draft: false });
  assert.deepEqual(readiness({ ...base, facts: "wip" }), { result: "wip", draft: true });
  assert.deepEqual(readiness({ ...base, facts: "unreviewed" }), { result: "unreviewed", draft: true });
  assert.deepEqual(readiness({ ...base, checks: "red" }), { result: "red", draft: null });
  assert.deepEqual(readiness({ ...base, checks: "running" }), { result: "running", draft: null });
  assert.deepEqual(readiness({ ...base, mergeable: false }), { result: "running", draft: null });
  for (const ms of ["behind", "dirty", "unknown"]) assert.deepEqual(readiness({ ...base, mergeState: ms }), { result: "running", draft: null }, ms);
  // blocked: waits on the host, but out of draft
  assert.deepEqual(readiness({ ...base, mergeState: "blocked" }), { result: "running", draft: false });
  // a draft that holds the rule apart from the draft state leaves draft (merge state draft or blocked does not keep it)
  assert.deepEqual(readiness({ ...base, draft: true, mergeState: "draft" }), { result: "running", draft: false });
  assert.deepEqual(readiness({ ...base, draft: true, mergeState: "blocked" }), { result: "running", draft: false });
});

test("readiness: checks running or red never send a PR back to draft; wip and unreviewed do, whatever the checks", () => {
  for (const checks of ["green", "red", "running"] as const) {
    assert.equal(readiness({ ...base, checks, facts: "ok" }).draft === true, false);
    assert.equal(readiness({ ...base, checks, facts: "wip" }).draft, true);
    assert.equal(readiness({ ...base, checks, facts: "unreviewed" }).draft, true);
  }
});

test("reload keeps the occasion of a review record; a bad one is dropped; a record without one stays without", () => {
  const kept = reviewsOfEntry([{ role: "reviewer", verdict: "pass", head: H, kind: "code", occasion: "pre-pr" }, { role: "reviewer", verdict: "pass", head: H, occasion: "bogus" }, { role: "reviewer", verdict: "pass", head: H }]);
  assert.equal(kept[0].occasion, "pre-pr");
  assert.equal("occasion" in kept[1], false);
  assert.equal("occasion" in kept[2], false);
  const entry = buildCeremonyState({ plan: null, lineages: [], planPhase: false, reviews: [rec(), rec({ occasion: "item" })] });
  assert.deepEqual(reviewsOfEntry(entry.reviews).map((r) => r.occasion), ["pre-pr", "item"]);
  assert.equal(reviewFactsOf(reviewsOfEntry(entry.reviews).slice(0, 1), H, false, false), "ok");
});
