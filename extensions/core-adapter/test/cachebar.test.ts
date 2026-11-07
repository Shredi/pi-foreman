// r65: the numbers of the footer's cache bar (cachebar.ts). The window/budget/away limiters are gone (warm redesign);
// the span, tier and warms-left cases live in cachebar-tier.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheBar, formatLeft, type CacheSnapshot } from "../cachebar.ts";

const T0 = 1_000_000_000;
const MIN = 60_000;

// TTL 300 s, no warm pending: the bar counts the touch-to-cold span.
const base: CacheSnapshot = {
  now: T0,
  lastTouch: T0,
  ttlSeconds: 300,
  stretchStartAt: T0,
  spanEndAt: null,
  warmsLeft: 0,
  tier: null,
  nextWarmAt: null,
};

test("nextWarmAt null: no warms, no tier", () => {
  const b = cacheBar({ ...base, warmsLeft: 3, tier: "half" });
  assert.equal(b.warmsLeft, 0);
  assert.equal(b.tier, null);
});

test("coldAt and share at touch, mid-TTL and past", () => {
  const span = 0.95 * 300_000;
  const at = cacheBar(base);
  assert.equal(at.coldAt, T0 + span);
  assert.equal(at.leftMs, span);
  assert.equal(at.share, 1);
  const mid = cacheBar({ ...base, now: T0 + span / 2 });
  assert.equal(mid.leftMs, span / 2);
  assert.equal(mid.share, 0.5);
  const past = cacheBar({ ...base, now: T0 + 10 * MIN });
  assert.equal(past.leftMs, 0);
  assert.equal(past.share, 0);
});

test("no touch: coldAt, left and share are null", () => {
  const b = cacheBar({ ...base, lastTouch: null });
  assert.equal(b.coldAt, null);
  assert.equal(b.leftMs, null);
  assert.equal(b.share, null);
});

test("formatLeft: mm:ss, h:mm:ss above an hour", () => {
  assert.equal(formatLeft(0), "00:00");
  assert.equal(formatLeft(-5), "00:00");
  assert.equal(formatLeft(9_999), "00:09");
  assert.equal(formatLeft(38 * MIN + 12_000), "38:12");
  assert.equal(formatLeft(59 * MIN + 59_000), "59:59");
  assert.equal(formatLeft(60 * MIN), "1:00:00");
  assert.equal(formatLeft(3_600_000 + 5 * MIN + 7_000), "1:05:07");
});
