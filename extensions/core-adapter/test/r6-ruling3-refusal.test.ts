// R6 lane 4c, ruling 3: a parent ruling never satisfies the finish gate; the refusal names it and the override line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptySteps, finishRefusal, initialReviewGate, onReviewVerdicts, openSteps, reviewHint } from "../bound.ts";
import { rulingNeeded, rulingOverrideNote } from "../ruling.ts";

test("ruling 3: a FAIL keeps the reviewer step open whatever ruling exists", () => {
  const failed = onReviewVerdicts(initialReviewGate(), ["fail"], 5_000_000_000);
  assert.deepEqual(openSteps({ ...emptySteps(), builder: 1 }, ["builder", "reviewer"], "pass", failed), ["reviewer"]);
});

test("ruling 3: the refusal names the ruling file, the FAIL time and the exact override line", () => {
  const failed = onReviewVerdicts(initialReviewGate(), ["fail"], 5_000_000_000);
  const text = finishRefusal("standard", ["reviewer"], reviewHint(failed)) + rulingOverrideNote("/h/up/ruling.md", 5_000_000_000);
  assert.equal(
    text,
    "pi-foreman: finish refused: tier standard requires reviewer (re-review needed: last verdict FAIL); launch them or ask the owner to lower the tier with /ceremony." +
      " A parent ruling /h/up/ruling.md is newer than the last FAIL verdict (1970-02-27T20:53:20.000Z), but a parent ruling never satisfies the finish gate; the owner/chair runs: /ceremony <tier>",
  );
});

test("ruling 3: /foreman close keeps listing what the parent must still rule", () => {
  assert.equal(rulingNeeded([]), "");
  assert.match(rulingNeeded(["reviewer"]), /Missing: reviewer\. The parent must still rule on it; .*\/ceremony <tier>/);
});
