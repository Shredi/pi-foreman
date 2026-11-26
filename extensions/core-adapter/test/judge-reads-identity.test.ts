// File identity in judgereads.ts is compared at full 64-bit width (NTFS file ids exceed 2^53).
import { test } from "node:test";
import assert from "node:assert/strict";
import type * as fs from "node:fs";
import { sameFileState } from "../judgereads.ts";

const stat = (over: Partial<fs.BigIntStats>): fs.BigIntStats => ({ dev: 1n, ino: 1n, size: 6n, mtimeNs: 5n, ctimeNs: 5n, ...over }) as fs.BigIntStats;

test("identity: inodes that differ only in the low bits beyond 2^53 are different files", () => {
  const big = 2n ** 60n;
  assert.equal(Number(big), Number(big + 1n), "as doubles the two ids collide");
  assert.equal(sameFileState(stat({ ino: big }), stat({ ino: big })), true);
  assert.equal(sameFileState(stat({ ino: big }), stat({ ino: big + 1n })), false);
});

test("identity: a different device, size or time is a different state", () => {
  assert.equal(sameFileState(stat({}), stat({ dev: 2n })), false);
  assert.equal(sameFileState(stat({}), stat({ size: 7n })), false);
  assert.equal(sameFileState(stat({}), stat({ mtimeNs: 6n })), false);
  assert.equal(sameFileState(stat({}), stat({ ctimeNs: 6n })), false);
});
