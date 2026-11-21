import { test } from "node:test";
import assert from "node:assert/strict";
import { unwrapTimeout } from "../timeoutallow.ts";

test("timeout: the wrapper is stripped only in the known forms", () => {
  assert.equal(unwrapTimeout("timeout 900 cargo test -p x"), "cargo test -p x");
  assert.equal(unwrapTimeout("timeout -s KILL -k 5 10s go test ./..."), "go test ./...");
  assert.equal(unwrapTimeout("timeout x go test"), null);
});
