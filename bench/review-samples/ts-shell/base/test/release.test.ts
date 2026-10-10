import { test } from "node:test";
import assert from "node:assert/strict";
import { nextVersion } from "../src/release.ts";

test("nextVersion bumps each part and keeps a leading v", () => {
  assert.equal(nextVersion("1.4.2", "patch"), "1.4.3");
  assert.equal(nextVersion("1.4.2", "minor"), "1.5.0");
  assert.equal(nextVersion("v1.4.2", "major"), "v2.0.0");
});

test("nextVersion rejects garbage", () => {
  assert.throws(() => nextVersion("1.x.2", "patch"));
});
