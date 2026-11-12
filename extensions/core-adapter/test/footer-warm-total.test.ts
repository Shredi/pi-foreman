// The footer's total warm time (current lifetime plus the warms the budget still allows), the lifetime bar that refills at
// each warm, and the one mark where the next warm fires, in every symbol set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheViewOf, markGlyph, tierGlyphs, type CacheSource } from "../footer.ts";
import { cacheBar, formatTotal } from "../cachebar.ts";
import { renderFooter, visibleWidth, type FooterView } from "../footerview.ts";
import { symbolSet } from "../symbols.ts";
import type { CachePolicy } from "../cachepolicy.ts";

const theme = { fg: (_c: string, t: string) => t };
const T0 = 1_700_000_000_000;
const TTL = 300;
const TICK = 270_000;
const POLICY: CachePolicy = { active: true, ttlSeconds: TTL, intervalSeconds: 270, windowMinutes: 45, effectiveWindowMinutes: 30, warmCompact: true, budgetShare: 0.5, awayTicks: 0 };
const src = (over: Partial<CacheSource> = {}): CacheSource => ({
  policy: POLICY, now: T0, lastTouch: T0, stretchStartAt: T0, nextWarmAt: T0 + TICK, spanEndAt: T0 + 3 * TICK + TTL * 1000, warmsLeft: 3, warmsFresh: 4, tier: "half",
  running: false, downshifted: false, idleRung: null, enabled: true, symbols: "unicode", ...over,
});
const line = (s: CacheSource, width = 200): string => {
  const v: FooterView = { model: "m", thinking: null, branch: null, contextPercent: 10, contextWindow: 1_000_000, cacheHit: null, usage: null, statuses: [], cache: cacheViewOf(s) ?? undefined };
  return renderFooter(v, width, theme)[0];
};
const MARKS = ["│", "|"];
const hasMark = (l: string): boolean => MARKS.some((m) => l.split(" · ").pop()!.includes(m));

test("formatTotal: mm:ss below 60 minutes, whole hours rounded down from 60", () => {
  assert.equal(formatTotal(59 * 60_000 + 59_000), "59:59");
  assert.equal(formatTotal(60 * 60_000), "1h");
  assert.equal(formatTotal(119 * 60_000 + 59_000), "1h");
  assert.equal(formatTotal(120 * 60_000), "2h");
  assert.equal(formatTotal(0), "00:00");
});

test("the time is the lifetime now plus the warms left, one warm interval each, in either tier", () => {
  assert.equal(cacheViewOf(src())!.left, "18:15"); // 285 s + 3 x 270 s
  assert.equal(cacheViewOf(src({ tier: "quarter", warmsLeft: 1 }))!.left, "09:15");
  assert.equal(cacheViewOf(src({ now: T0 + 100_000, warmsLeft: 2 }))!.left, "12:05"); // 185 s + 2 x 270 s
  assert.equal(cacheViewOf(src({ policy: { ...POLICY, ttlSeconds: 3600 }, warmsLeft: 5, nextWarmAt: T0 + 3_240_000 }))!.left, "5h"); // 3420 s + 5 x 3240 s
});

test("the bar is the current lifetime and refills at each warm", () => {
  const before = cacheViewOf(src({ now: T0 + 270_000 }))!;
  assert.ok(Math.abs(before.share! - 15 / 285) < 1e-9);
  const after = cacheViewOf(src({ now: T0 + 270_500, lastTouch: T0 + 270_500, nextWarmAt: T0 + 270_500 + TICK, warmsLeft: 2 }))!;
  assert.equal(after.share, 1);
  assert.equal(cacheBar({ now: T0 + 142_500, lastTouch: T0, ttlSeconds: TTL, stretchStartAt: T0, spanEndAt: null, warmsLeft: 0, tier: null, nextWarmAt: null }).lifeShare, 0.5);
});

test("the mark sits where the next warm fires: after the first cell of 10", () => {
  const b = cacheBar({ now: T0, lastTouch: T0, ttlSeconds: TTL, stretchStartAt: T0, spanEndAt: null, warmsLeft: 3, tier: "half", nextWarmAt: T0 + TICK });
  assert.ok(Math.abs(b.markShare! - 15 / 285) < 1e-9);
  assert.equal(cacheBar({ now: T0, lastTouch: T0, ttlSeconds: TTL, stretchStartAt: T0, spanEndAt: null, warmsLeft: 3, tier: "half", nextWarmAt: null }).markShare, null);
  // a different warm lead moves the mark: a warm at half the lifetime sits after cell 5
  const mid = cacheViewOf(src({ nextWarmAt: T0 + 142_500 }))!;
  assert.match(line(src({ nextWarmAt: T0 + 142_500 })), /■■■■■│■■■■■ 18:15/);
  assert.equal(mid.mark, 0.5);
});

test("every symbol set draws the mark, `|` in ascii", () => {
  for (const set of ["unicode", "emoji", "nerd", "ascii"]) {
    const sym = symbolSet(set);
    const tier = tierGlyphs(set).half;
    const mark = set === "ascii" ? "|" : "│";
    assert.equal(markGlyph(set), mark, set);
    assert.equal(line(src({ symbols: set })).split(" · ").pop(), `■${mark}■■■■■■■■■ 18:15 ${sym.keepalive} ${tier}`, set);
  }
});

test("no mark when no warm is coming: miss, error, budget used up, disabled, busy, cold", () => {
  const off = [
    src({ endedBy: "miss", warmsLeft: 0, nextWarmAt: null }),
    src({ endedBy: "error", warmsLeft: 0, nextWarmAt: null }),
    src({ endedBy: "miss" }),
    src({ warmsLeft: 0, nextWarmAt: null }),
    src({ policy: { ...POLICY, active: false, skip: "disabled" } }),
    src({ running: true }),
    src({ lastTouch: null, nextWarmAt: null }),
    src({ now: T0 + 3_600_000 }),
  ];
  for (const s of off) {
    for (const set of ["unicode", "ascii"]) {
      const l = line({ ...s, symbols: set });
      assert.ok(!hasMark(l), l);
      assert.equal(cacheViewOf({ ...s, symbols: set })!.mark, null);
    }
  }
});

test("miss and error keep the plain countdown, budget used up and disabled drop the ♨", () => {
  assert.match(line(src({ endedBy: "miss" })), /■■■■■■■■■■ 04:45 ♨ miss$/);
  assert.match(line(src({ endedBy: "error" })), /■■■■■■■■■■ 04:45 ♨ err$/);
  assert.match(line(src({ warmsLeft: 0, nextWarmAt: null })), /■■■■■■■■■■ 04:45 ½$/);
  assert.match(line(src({ policy: { ...POLICY, active: false, skip: "disabled" } })), /■■■■■■■■■■ 04:45 ½$/);
});

test("the mark adds one column and the width rules count it", () => {
  const withMark = line(src());
  const without = line(src({ warmsLeft: 0, nextWarmAt: null }));
  // the mark column plus the " ♨" (the time has 5 columns in both)
  assert.equal(visibleWidth(withMark) - visibleWidth(without), 1 + visibleWidth(" ♨"));
  // the line never overflows, at the exact width and below it
  for (const width of [visibleWidth(withMark), visibleWidth(withMark) - 1, 40, 30]) {
    assert.ok(visibleWidth(line(src(), width)) <= width, `width ${width}`);
  }
});
