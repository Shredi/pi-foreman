// Footer cache bar of the warm redesign: share of the current cache lifetime, a mark where the next warm fires, the total
// warm time (plain countdown without a coming warm), `♨` and the tier glyph with ASCII fallback, and no limiter word.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheViewOf, tierGlyphs, type CacheSource } from "../footer.ts";
import { cacheBar, type CacheSnapshot } from "../cachebar.ts";
import { renderFooter, type FooterView } from "../footerview.ts";
import type { CachePolicy } from "../cachepolicy.ts";

const CODE = { success: "32", warning: "33", error: "31", dim: "2" } as const;
const theme = { fg: (c: keyof typeof CODE, t: string) => `\x1b[${CODE[c]}m${t}\x1b[0m` };
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const T0 = 1_000_000_000;
const TTL = 300;
const TICK = 270_000; // 0.9 x 300 s
const COLD_SPAN = 0.95 * TTL * 1000;

const snap = (over: Partial<CacheSnapshot> = {}): CacheSnapshot => ({
  now: T0,
  lastTouch: T0,
  ttlSeconds: TTL,
  stretchStartAt: T0,
  spanEndAt: T0 + 3 * TICK + TTL * 1000,
  warmsLeft: 3,
  tier: "half",
  nextWarmAt: T0 + TICK,
  ...over,
});

test("share covers the whole projected warm span: stretch start until the last warm's TTL end", () => {
  const span = 3 * TICK + TTL * 1000;
  const start = cacheBar(snap());
  assert.equal(start.share, 1);
  const mid = cacheBar(snap({ now: T0 + span / 2 }));
  assert.equal(mid.share, 0.5);
  // the stretch started earlier than the latest touch (a warm went out): the span still counts from the start
  const later = cacheBar(snap({ now: T0 + TICK, lastTouch: T0 + TICK, stretchStartAt: T0, spanEndAt: T0 + 3 * TICK + TTL * 1000, warmsLeft: 2 }));
  assert.equal(later.share, (span - TICK) / span);
});

test("the time is the countdown to cold at the current TTL, not to the span end", () => {
  const b = cacheBar(snap({ now: T0 + 100_000 }));
  assert.equal(b.leftMs, COLD_SPAN - 100_000);
  const longer = cacheBar(snap({ ttlSeconds: 3600, now: T0 }));
  assert.equal(longer.leftMs, 0.95 * 3600_000);
});

test("warms left and the tier pass through; no warm pending clears both and falls back to the cold span", () => {
  const q = cacheBar(snap({ tier: "quarter", warmsLeft: 1 }));
  assert.equal(q.warmsLeft, 1);
  assert.equal(q.tier, "quarter");
  const none = cacheBar(snap({ nextWarmAt: null, now: T0 + COLD_SPAN / 2 }));
  assert.equal(none.warmsLeft, 0);
  assert.equal(none.tier, null);
  assert.equal(none.share, 0.5);
  assert.equal(cacheBar(snap({ warmsLeft: 0 })).tier, null);
});

const POLICY: CachePolicy = { active: true, ttlSeconds: TTL, intervalSeconds: 270, windowMinutes: 45, effectiveWindowMinutes: 30, warmCompact: true, budgetShare: 0.5, awayTicks: 0 };
const src = (over: Partial<CacheSource> = {}): CacheSource => ({
  policy: POLICY,
  now: T0,
  lastTouch: T0,
  stretchStartAt: T0,
  nextWarmAt: T0 + TICK,
  spanEndAt: T0 + 3 * TICK + TTL * 1000,
  warmsLeft: 3,
  tier: "half",
  running: false,
  downshifted: false,
  idleRung: null,
  enabled: true,
  symbols: "unicode",
  ...over,
});
const line = (cache: ReturnType<typeof cacheViewOf>): string => {
  const v: FooterView = { model: "m", thinking: null, branch: null, contextPercent: 10, contextWindow: 1_000_000, cacheHit: null, usage: null, statuses: [], cache: cache ?? undefined };
  return plain(renderFooter(v, 200, theme)[0]);
};

test("rendering: cells with the mark, total warm time, keepalive glyph, tier glyph", () => {
  const l = line(cacheViewOf(src())!);
  assert.match(l, /■│■■■■■■■■■ 18:15 ♨ ½$/);
  assert.match(line(cacheViewOf(src({ tier: "quarter", warmsLeft: 1 }))!), /■│■■■■■■■■■ 09:15 ♨ ¼$/);
});

test("ASCII fallback spells the tier glyphs 1/2 and 1/4", () => {
  assert.deepEqual(tierGlyphs("ascii"), { half: "1/2", quarter: "1/4" });
  assert.deepEqual(tierGlyphs("unicode"), { half: "½", quarter: "¼" });
  assert.match(line(cacheViewOf(src({ symbols: "ascii" }))!), /■\|■■■■■■■■■ 18:15 \^ 1\/2$/);
  assert.match(line(cacheViewOf(src({ symbols: "ascii", tier: "quarter" }))!), /■\|■■■■■■■■■ 18:15 \^ 1\/4$/);
});

test("no limiter word and no (away n) in any state", () => {
  for (const over of [{}, { tier: "quarter" as const, warmsLeft: 1 }, { warmsLeft: 0 }, { running: true }]) {
    assert.doesNotMatch(line(cacheViewOf(src(over))!), /window|budget|away/);
  }
});

test("cold stays `□□□ ❄ cold`, the tier glyph follows", () => {
  const l = line(cacheViewOf(src({ lastTouch: null, nextWarmAt: null }))!);
  assert.match(l, /□□□□□□□□□□ ❄ cold ½$/);
});

test("no warms left or a running turn without fresh warms: plain countdown, no `♨`, the tier glyph", () => {
  assert.match(line(cacheViewOf(src({ warmsLeft: 0 }))!), /■■■■■■■■■■ 04:45 ½$/);
  assert.match(line(cacheViewOf(src({ running: true }))!), /■■■■■■■■■■ 04:45 ½$/);
});
