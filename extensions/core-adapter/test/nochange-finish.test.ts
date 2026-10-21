// Ceremony no-change finish (ledger nochange-finish): a session that built nothing, edited nothing and leaves a clean tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptySteps, noChange } from "../bound.ts";

test("noChange: clean tree, no builder, no foreman edit", () => {
  assert.equal(noChange(emptySteps(), 0, ""), true);
});

test("noChange: a completed builder run is a change", () => {
  assert.equal(noChange({ ...emptySteps(), builder: 1 }, 0, ""), false);
});

test("noChange: a foreman project-file edit is a change", () => {
  assert.equal(noChange(emptySteps(), 1, ""), false);
});

test("noChange: a dirty work tree is a change", () => {
  assert.equal(noChange(emptySteps(), 0, " M src/a.ts\n"), false);
  assert.equal(noChange(emptySteps(), 0, "?? notes.md\n"), false);
});

test("noChange: a git failure or no git tree (null) is not a no-change", () => {
  assert.equal(noChange(emptySteps(), 0, null), false);
});
