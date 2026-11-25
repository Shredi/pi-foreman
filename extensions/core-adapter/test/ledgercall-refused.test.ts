import { test } from "node:test";
import assert from "node:assert/strict";
import { isPermissionDeny } from "../ledgercall.ts";

test("a judge refusal or a protected-target refusal (pi-foreman: refused: ...) is a permission deny for the ledger trace", () => {
  // the texts index.ts builds in judgeRefusalText and for a refused protected target
  const judge = "pi-foreman: refused: the permission judge refused it: scripted unsure Nobody is asked. Rewrite the call (split it, use a tool, use paths the gate can read) or report it to the foreman.";
  const protectedTarget = "pi-foreman: refused: prod-db is protected and the check did not allow this call (model): no reason given Nobody is asked.";
  assert.equal(isPermissionDeny(true, judge), true);
  assert.equal(isPermissionDeny(true, protectedTarget), true);
  assert.equal(isPermissionDeny(false, judge), false);
  assert.equal(isPermissionDeny(true, "pi-foreman ledger: refused: item 3 is not open"), false);
});
