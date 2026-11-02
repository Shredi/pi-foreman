// Ladder item 3: checkLaunch marks the open FAIL as answered by a revision builder (security-exempt included),
// onReviewDone clears it, and the flag survives the round-state file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLaunch, initialRounds, onReviewDone, type RoundState } from "../rounds.ts";
import { chainsOf } from "../roundstate.ts";

const open: RoundState = { built: true, reviewOpen: true, used: 0 };

test("a counted revision sets revisionAnswered; a builder after it is no further round", () => {
  const first = checkLaunch(open, [["builder"]], "standard", undefined);
  assert.equal(first.revisions, 1);
  assert.equal(first.next.used, 1);
  assert.equal(first.next.revisionAnswered, true);
  const second = checkLaunch(first.next, [["builder"]], "standard", undefined);
  assert.equal(second.revisions, 0);
  assert.equal(second.next.used, 1);
  assert.equal(second.next.revisionAnswered, true);
});

test("a security-exempt revision sets the flag too", () => {
  const r = checkLaunch({ ...open, secOpen: true }, [["builder"]], "standard", undefined);
  assert.equal(r.exempt, 1);
  assert.equal(r.next.revisionAnswered, true);
});

test("a first builder (no review open) does not set it", () => {
  assert.equal(checkLaunch(initialRounds(), [["builder"]], "standard", undefined).next.revisionAnswered, undefined);
});

test("the next verdict clears it; the persisted chain keeps it", () => {
  const answered = checkLaunch(open, [["builder"]], "standard", undefined).next;
  assert.equal(chainsOf(new Map([["main", answered]])).main.revisionAnswered, true);
  assert.equal(onReviewDone(answered, "fail").revisionAnswered, undefined);
  assert.equal(onReviewDone(answered, "pass").revisionAnswered, undefined);
});
