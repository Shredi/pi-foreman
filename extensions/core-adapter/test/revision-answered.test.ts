// Ladder item 3: walkLaunch marks the open FAIL as answered by a revision builder, onReviewDone clears it,
// and the flag survives the round-state file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { initialRounds, onReviewDone, walkLaunch, type RoundState } from "../rounds.ts";

const open: RoundState = { built: true, reviewOpen: true };

test("a revision sets revisionAnswered; a builder after it is no further round", () => {
  const first = walkLaunch(open, [["builder"]]);
  assert.equal(first.revisions, 1);
  assert.equal(first.next.revisionAnswered, true);
  const second = walkLaunch(first.next, [["builder"]]);
  assert.equal(second.revisions, 0);
  assert.equal(second.next.revisionAnswered, true);
});

test("a first builder (no review open) does not set it", () => {
  assert.equal(walkLaunch(initialRounds(), [["builder"]]).next.revisionAnswered, undefined);
});

test("the next verdict clears it", () => {
  const answered = walkLaunch(open, [["builder"]]).next;
  assert.equal(onReviewDone(answered, "fail").revisionAnswered, undefined);
  assert.equal(onReviewDone(answered, "pass").revisionAnswered, undefined);
});
