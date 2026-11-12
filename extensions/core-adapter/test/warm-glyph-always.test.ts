// The footer cache bar always carries the keep-alive part `♨ N` and the budget-tier glyph: a running turn shows the
// warms a fresh idle stretch would allow, "no warm allowed" and cold show `♨ 0`, narrow widths keep the warm part.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheViewOf, type CacheSource } from "../footer.ts";
import { renderFooter, visibleWidth, type FooterView } from "../footerview.ts";
import type { CachePolicy } from "../cachepolicy.ts";

const theme = { fg: (_c: string, t: string) => t };
const T0 = 1_700_000_000_000;
const TTL = 300;
const TICK = 270_000;
const POLICY: CachePolicy = { active: true, ttlSeconds: TTL, intervalSeconds: 270, windowMinutes: 45, effectiveWindowMinutes: 30, warmCompact: true, budgetShare: 0.5, awayTicks: 0 };
const src = (over: Partial<CacheSource> = {}): CacheSource => ({
  policy: POLICY,
  now: T0,
  lastTouch: T0,
  stretchStartAt: T0,
  nextWarmAt: T0 + TICK,
  spanEndAt: T0 + 3 * TICK + TTL * 1000,
  warmsLeft: 3,
  warmsFresh: 4,
  tier: "quarter",
  running: false,
  downshifted: false,
  idleRung: null,
  enabled: true,
  symbols: "unicode",
  ...over,
});
const line = (s: CacheSource | null, width = 200, branch: string | null = null): string => {
  const cache = cacheViewOf(s) ?? undefined;
  const v: FooterView = { model: "m", thinking: null, branch, contextPercent: 10, contextWindow: 1_000_000, cacheHit: null, usage: null, statuses: [], cache };
  return renderFooter(v, width, theme)[0];
};

test("running turn: the fresh-stretch count and the tier glyph", () => {
  assert.match(line(src({ running: true, warmsLeft: 0 })), /■■■■■■■■■■ 04:45 ♨ ¼$/);
  assert.match(line(src({ running: true, warmsFresh: 1 })), /■■■■■■■■■■ 04:45 ♨ ¼$/);
});

test("budget spent: `♨ 0` with the tier glyph", () => {
  assert.match(line(src({ warmsLeft: 0, nextWarmAt: null })), /■■■■■■■■■■ 04:45 ¼$/);
});

test("keep-alive disabled or ttl_long without owned keep-alive: `♨ 0` with the glyph, also while running", () => {
  for (const policy of [{ ...POLICY, active: false, skip: "disabled" as const }, { ...POLICY, skip: "ttl_long" as const, keepaliveOwned: false }]) {
    assert.match(line(src({ policy })), /■■■■■■■■■■ 04:45 ¼$/);
    assert.match(line(src({ policy, running: true })), /■■■■■■■■■■ 04:45 ¼$/);
  }
});

test("no tier known: `♨ 0` without a glyph", () => {
  assert.match(line(src({ warmsLeft: 0, nextWarmAt: null, tier: null })), /■■■■■■■■■■ 04:45$/);
});

test("cold: `❄ cold ♨ 0 <tier>`", () => {
  assert.match(line(src({ lastTouch: null, nextWarmAt: null })), /□□□□□□□□□□ ❄ cold ¼$/);
  assert.match(line(src({ now: T0 + 3_600_000 })), /❄ cold ¼$/);
});

test("one warm left: `♨ last`", () => {
  assert.match(line(src({ warmsLeft: 1 })), /■│■■■■■■■■■ 09:15 ♨ ¼$/);
});

test("ascii glyphs", () => {
  assert.match(line(src({ symbols: "ascii", running: true })), /\^ 1\/4$/);
  assert.match(line(src({ symbols: "ascii", warmsLeft: 0, nextWarmAt: null, tier: "half" })), /04:45 1\/2$/);
});

test("narrow: branch, then the step, then 10 -> 5 cells; the warm part stays", () => {
  const s = src({ idleRung: "claude-sonnet-5-5" });
  const full = line(s, 200, "br");
  assert.match(full, /^m · br · .*♨ ¼ · ↓ claude-sonnet-5-5$/);
  const noBranch = line(s, visibleWidth(full) - 1, "br");
  assert.ok(!noBranch.includes("br ·") && noBranch.endsWith("↓ claude-sonnet-5-5"), noBranch);
  const noStep = line(s, visibleWidth(noBranch) - 1, "br");
  assert.ok(noStep.endsWith("♨ ¼") && !noStep.includes("↓") && noStep.includes("■│■■■■■■■■■"), noStep);
  const five = line(s, visibleWidth(noStep) - 1, "br");
  assert.ok(five.endsWith("♨ ¼") && !five.includes("■│■■■■■■■■■") && !five.includes("↓"), five);
  assert.match(line(s, visibleWidth(five) - 3, "br"), /…\x1b\[0m$/);
});

test("hidden cases stay hidden", () => {
  assert.equal(cacheViewOf(null), null);
  assert.equal(cacheViewOf(src({ enabled: false })), null);
  assert.equal(cacheViewOf(src({ policy: null })), null);
  assert.equal(cacheViewOf(src({ policy: { ...POLICY, active: false, skip: "no_entry", ttlSeconds: null } })), null);
  assert.equal(cacheViewOf(src({ policy: { ...POLICY, active: false, skip: "ttl_unknown", ttlSeconds: null } })), null);
});
