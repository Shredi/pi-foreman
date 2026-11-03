// Footer cache bar: the away cap while the owner is present (`6 (away 2)`), D11.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheViewOf, type CacheSource } from "../footer.ts";
import { cacheBar } from "../cachebar.ts";
import { renderFooter, type FooterView } from "../footerview.ts";
import type { CachePolicy } from "../cachepolicy.ts";

const CODE = { success: "32", warning: "33", error: "31", dim: "2" } as const;
const theme = { fg: (c: keyof typeof CODE, t: string) => `\x1b[${CODE[c]}m${t}\x1b[0m` };
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const POLICY: CachePolicy = { active: true, ttlSeconds: 300, billing: "token", intervalSeconds: 270, windowMinutes: 45, effectiveWindowMinutes: 30, warmCompact: true, budgetShare: 0.5, awayTicks: 2 };
const NOW = 1_000_000;
// last touch now, the next warm one tick on, the window 7 ticks long -> the window allows 6 warms, like Pi's 30 minutes on a 5-minute TTL
const src = (over: Partial<CacheSource> = {}): CacheSource => ({
  policy: POLICY,
  now: NOW,
  lastTouch: NOW,
  windowEndAt: NOW + 7 * 270_000,
  nextWarmAt: NOW + 270_000,
  tickMs: 270_000,
  budget: null,
  away: { isAway: false, used: 0, ticks: 2 },
  running: false,
  downshifted: false,
  idleRung: null,
  enabled: true,
  symbols: "unicode",
  ...over,
});
const view = (cache: ReturnType<typeof cacheViewOf>): FooterView => ({ model: "m", thinking: null, branch: null, contextPercent: 10, contextWindow: 1_000_000, cacheHit: 90, usage: null, statuses: [], cache: cache ?? undefined });
const line = (cache: ReturnType<typeof cacheViewOf>): string => plain(renderFooter(view(cache), 200, theme)[0]);

test("D11: present, awayTicks 2, window count 6 -> warms 6, awayLeft 2, render `6 (away 2)`", () => {
  const v = cacheViewOf(src())!;
  assert.equal(v.warms?.count, 6);
  assert.equal(v.warms?.limiter, null);
  assert.equal(v.awayLeft, 2);
  assert.match(line(v), /♨ 6 \(away 2\)/);
});

test("D11: the away cap shrinks with the used ticks and is not shown when it is not below the count", () => {
  const used = cacheViewOf(src({ away: { isAway: false, used: 1, ticks: 2 } }))!;
  assert.equal(used.awayLeft, 1);
  assert.match(line(used), /6 \(away 1\)/);
  const spent = cacheViewOf(src({ away: { isAway: false, used: 2, ticks: 2 } }))!;
  assert.equal(spent.awayLeft, 0);
  const wide = cacheViewOf(src({ away: { isAway: false, used: 0, ticks: 9 } }))!;
  assert.equal(wide.awayLeft, 9);
  assert.doesNotMatch(line(wide), /away/);
});

test("D11: awayTicks 0 present -> awayLeft null, no bracket (default installs see no change)", () => {
  const v = cacheViewOf(src({ policy: { ...POLICY, awayTicks: 0 }, away: null }))!;
  assert.equal(v.awayLeft, null);
  assert.equal(v.warms?.count, 6);
  assert.doesNotMatch(line(v), /away/);
  const zero = cacheViewOf(src({ policy: { ...POLICY, awayTicks: 0 }, away: { isAway: false, used: 0, ticks: 0 } }))!;
  assert.equal(zero.awayLeft, null);
});

test("D11: away with the cap used up -> cacheBar warmsLeft 0 and limiter away; the view shows no count", () => {
  const s = src({ away: { isAway: true, used: 0, ticks: 0 }, policy: { ...POLICY, awayTicks: 0 } });
  const bar = cacheBar({ now: s.now, lastTouch: s.lastTouch, ttlSeconds: 300, nextWarmAt: s.nextWarmAt, windowEndAt: s.windowEndAt, tickMs: s.tickMs, budget: null, away: s.away });
  assert.equal(bar.warmsLeft, 0);
  assert.equal(bar.limiter, "away");
  const v = cacheViewOf(s)!;
  assert.equal(v.warms, null);
  assert.doesNotMatch(line(v), /♨/);
});

test("D11: away with warms left shows the count with the away limiter and no bracket", () => {
  const v = cacheViewOf(src({ away: { isAway: true, used: 0, ticks: 2 } }))!;
  assert.deepEqual(v.warms, { count: 2, limiter: "away" });
  assert.equal(v.awayLeft, 2);
  assert.match(line(v), /♨ 2 away$/);
});
