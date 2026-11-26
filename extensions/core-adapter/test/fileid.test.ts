import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { handoffStatsMatch, readHandoffPlan } from "../checkpoint.ts";
import { fileIdOf, sameFileId } from "../fileid.ts";
import { openedMatches, readGuarded } from "../pageserver.ts";
import { sigOfStats } from "../permconfig.ts";
import { lsKeyOf } from "../readonlystate.ts";
import { sameFileStats } from "../selfmod.ts";

const A = 2n ** 60n;
const B = 2n ** 60n + 1n;
const fake = (ino: bigint, over: Record<string, unknown> = {}): fs.BigIntStats =>
  ({ dev: 1n, ino, nlink: 1n, size: 6n, mtimeNs: 5n, ctimeNs: 5n, isFile: () => true, isSymbolicLink: () => false, ...over }) as unknown as fs.BigIntStats;

test("the two ids are equal as numbers and different as bigint", () => {
  assert.equal(Number(A), Number(B));
  assert.notEqual(A, B);
});

test("fileid: exact compare, unknown id fails closed", () => {
  assert.equal(sameFileId(fake(A), fake(B)), false);
  assert.equal(sameFileId(fake(A), fake(A)), true);
  assert.equal(sameFileId(fake(0n), fake(0n)), false);
  assert.equal(fileIdOf(fake(0n)), null);
  assert.equal(fileIdOf(fake(A)), `1:${A}`);
});

test("pageserver openedMatches", () => {
  assert.equal(openedMatches(fake(A), fake(B)), false);
  assert.equal(openedMatches(fake(A), fake(A)), true);
  assert.equal(openedMatches(fake(0n), fake(0n)), false);
});

test("checkpoint handoffStatsMatch", () => {
  assert.equal(handoffStatsMatch(fake(A), fake(B)), false);
  assert.equal(handoffStatsMatch(fake(A), fake(A)), true);
  assert.equal(handoffStatsMatch(fake(0n), fake(0n)), false);
  assert.equal(handoffStatsMatch(fake(A), fake(A, { size: 7n })), false);
});

test("selfmod sameFileStats", () => {
  assert.equal(sameFileStats(fake(A, { nlink: 2n }), fake(B)), false);
  assert.equal(sameFileStats(fake(A, { nlink: 2n }), fake(A)), true);
  assert.equal(sameFileStats(fake(0n, { nlink: 2n }), fake(B)), true);
  assert.equal(sameFileStats(fake(A, { nlink: 2n }), fake(0n)), true);
  assert.equal(sameFileStats(fake(0n, { nlink: 1n }), fake(0n)), false);
});

test("cache keys differ for ids that collide as numbers", () => {
  assert.notEqual(lsKeyOf(fake(A)), lsKeyOf(fake(B)));
  assert.equal(lsKeyOf(fake(A)), lsKeyOf(fake(A)));
  assert.notEqual(sigOfStats(fake(A)), sigOfStats(fake(B)));
  assert.equal(sigOfStats(fake(A)), sigOfStats(fake(A)));
});

test("real files: guarded reads still work", () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fileid-")));
  try {
    const f = path.join(dir, "plan.md");
    fs.writeFileSync(f, "# plan\n");
    assert.equal(readGuarded(f, "file", f)?.toString(), "# plan\n");
    const r = readHandoffPlan(dir, process.platform);
    assert.ok("plan" in r);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
