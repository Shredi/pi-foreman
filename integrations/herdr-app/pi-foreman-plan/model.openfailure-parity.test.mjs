import test from "node:test";
import assert from "node:assert/strict";
import * as mine from "./model.js";
import * as agents from "../pi-foreman/model.js";

// The loader refuses a cross-mod import, so plan/model.js carries a copy of openFailure; it must stay equal.
test("openFailure is the same source as in the Agents mod", () => {
  assert.equal(String(mine.openFailure), String(agents.openFailure));
});
