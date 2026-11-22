import assert from "node:assert/strict";
import { test } from "node:test";
import { strOf, strRaw } from "../strof.ts";

test("strOf gives the text of any value and an empty text for null and undefined", () => {
  assert.equal(strOf(undefined), "");
  assert.equal(strOf(null), "");
  assert.equal(strOf(0), "0");
  assert.equal(strOf(false), "false");
  assert.equal(strOf("x"), "x");
  assert.equal(strOf(["a", "b"]), "a,b");
});

test("strRaw is String(): null and undefined print as such", () => {
  assert.equal(strRaw(undefined), "undefined");
  assert.equal(strRaw(null), "null");
  assert.equal(strRaw(12), "12");
});
