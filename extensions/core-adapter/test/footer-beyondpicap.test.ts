// The footer warm projection at TTL >= 3600 does not depend on the deprecated `keepalive.beyondPiCap`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheViewOf, type CacheSource } from "../footer.ts";
import { resolveWarmPolicy } from "../cachepolicy.ts";

const NOW = 2_000_000_000_000;
const TTL = 3600;

function view(beyondPiCap: boolean | undefined) {
  const keepalive = beyondPiCap === undefined ? { enabled: true } : { enabled: true, beyondPiCap };
  const policy = resolveWarmPolicy({ providers: { p: { cache: { ttlSeconds: TTL, billing: "token", keepalive } } } }, "p");
  const src: CacheSource = {
    policy,
    now: NOW,
    lastTouch: NOW - 60_000,
    stretchStartAt: NOW - 60_000,
    nextWarmAt: NOW + 60_000,
    spanEndAt: NOW + 3 * 0.9 * TTL * 1000,
    warmsLeft: 3,
    tier: "half",
    running: false,
    downshifted: false,
    idleRung: null,
    enabled: true,
    symbols: "unicode",
  };
  return cacheViewOf(src);
}

test("TTL 3600: beyondPiCap false, true and absent show the same warms and tier", () => {
  const absent = view(undefined);
  assert.equal(absent?.warms?.count, 3);
  assert.equal(absent?.warms?.tier, "half");
  for (const v of [false, true]) {
    const got = view(v);
    assert.deepEqual(got?.warms, absent?.warms, `beyondPiCap ${v}`);
    assert.equal(got?.glyphs.half, absent?.glyphs.half);
  }
});
