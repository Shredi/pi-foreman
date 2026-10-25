// r65: the numbers of the footer's cache bar (cachebar.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheBar, formatLeft, type CacheSnapshot } from "../cachebar.ts";

const T0 = 1_000_000_000;
const MIN = 60_000;

// TTL 300 s, Pi's 30-minute cap: ticks at 270 s steps.
const base: CacheSnapshot = {
  now: T0,
  lastTouch: T0,
  ttlSeconds: 300,
  nextWarmAt: T0 + 270_000,
  windowEndAt: T0 + 30 * MIN,
  tickMs: 270_000,
  budget: null,
  away: null,
};

test("window-limited: TTL 300 with the 30-minute cap gives 6 warms", () => {
  const b = cacheBar(base);
  assert.equal(b.warmsLeft, 6);
  assert.equal(b.limiter, "window");
});

test("fractional tickMs: ticks strictly before the window end, no float noise", () => {
  const tickMs = 0.9 * 300 * 1000 + 0.1;
  const first = T0 + tickMs;
  const warms = (windowEndAt: number) => cacheBar({ ...base, tickMs, nextWarmAt: first, windowEndAt }).warmsLeft;
  assert.equal(warms(first + 3 * tickMs), 3);
  assert.equal(warms(first + 3 * tickMs + tickMs / 2), 4);
  assert.equal(warms(first + 3 * tickMs - 0.5), 3);
  assert.equal(warms(first), 0);
});

test("a warm exactly at the window end is not counted", () => {
  assert.equal(cacheBar({ ...base, windowEndAt: T0 + 270_000 }).warmsLeft, 0);
  assert.equal(cacheBar({ ...base, windowEndAt: T0 + 270_001 }).warmsLeft, 1);
});

test("budget-limited: 1 left with limiter budget", () => {
  const b = cacheBar({ ...base, budget: { spent: 0.2, cold: 1, next: 0.1, share: 0.3 } });
  assert.equal(b.warmsLeft, 1);
  assert.equal(b.limiter, "budget");
});

test("a budget that allows more than the window is not the limiter; a tie goes to the window", () => {
  assert.equal(cacheBar({ ...base, budget: { spent: 0, cold: 10, next: 0.1, share: 0.5 } }).limiter, "window");
  const tie = cacheBar({ ...base, budget: { spent: 0, cold: 1, next: 0.1, share: 0.6 } });
  assert.equal(tie.warmsLeft, 6);
  assert.equal(tie.limiter, "window");
});

test("away-limited: awayTicks 2 used 1 leaves 1 with limiter away", () => {
  const b = cacheBar({ ...base, away: { isAway: true, used: 1, ticks: 2 } });
  assert.equal(b.warmsLeft, 1);
  assert.equal(b.limiter, "away");
});

test("present owner: the away counter does not limit", () => {
  const b = cacheBar({ ...base, away: { isAway: false, used: 2, ticks: 2 } });
  assert.equal(b.warmsLeft, 6);
  assert.equal(b.limiter, "window");
});

test("budget null does not limit", () => {
  assert.equal(cacheBar({ ...base, budget: null }).warmsLeft, 6);
});

test("nextWarmAt null: no warms, no limiter", () => {
  const b = cacheBar({ ...base, nextWarmAt: null });
  assert.equal(b.warmsLeft, 0);
  assert.equal(b.limiter, null);
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
