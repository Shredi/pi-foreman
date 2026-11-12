// The footer's warm part for the idle stretch a miss or an error ended: ` ♨ miss` / ` ♨ err` instead of the count and the tier
// glyph, within the 7 columns of ` ♨ 0 ½`, kept at narrow widths, gone with the next stretch (a running turn or a cleared ending).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheViewOf, type CacheSource } from "../footer.ts";
import { renderFooter, visibleWidth, type FooterView } from "../footerview.ts";
import type { CachePolicy } from "../cachepolicy.ts";

const theme = { fg: (_c: string, t: string) => t };
const T0 = 1_700_000_000_000;
const POLICY: CachePolicy = { active: true, ttlSeconds: 300, billing: "token", intervalSeconds: 270, windowMinutes: 45, effectiveWindowMinutes: 30, warmCompact: true, budgetShare: 0.5, awayTicks: 0 };
const src = (over: Partial<CacheSource> = {}): CacheSource => ({
  policy: POLICY, now: T0 + 1000, lastTouch: T0, stretchStartAt: T0, nextWarmAt: null, spanEndAt: T0 + 300_000, warmsLeft: 0, warmsFresh: 4, tier: "half",
  running: false, downshifted: false, idleRung: null, enabled: true, symbols: "unicode", ...over,
});
const line = (s: CacheSource, width = 200): string => {
  const cache = cacheViewOf(s) ?? undefined;
  const v: FooterView = { model: "m", thinking: null, branch: null, contextPercent: 10, contextWindow: 1_000_000, cacheHit: null, usage: null, statuses: [], cache };
  return renderFooter(v, width, theme)[0];
};

test("a miss shows ♨ miss, an error ♨ err, without the count and the tier glyph", () => {
  assert.match(line(src({ endedBy: "miss" })), / ♨ miss$/);
  assert.match(line(src({ endedBy: "error" })), / ♨ err$/);
  assert.match(line(src({ endedBy: "miss", symbols: "ascii" })), /miss$/);
});

test("the ending text takes at most 7 columns (the warm part of a count and a tier glyph is 6)", () => {
  const normal = line(src({ endedBy: null, warmsLeft: 0 }));
  assert.match(normal, / ♨ 0 ½$/);
  const base = visibleWidth(normal) - visibleWidth(" ♨ 0 ½");
  for (const e of ["miss", "error"] as const) assert.ok(visibleWidth(line(src({ endedBy: e }))) - base <= 7, e);
});

test("narrow widths keep the ending text", () => {
  for (const width of [80, 60, 50, 45]) assert.match(line(src({ endedBy: "miss" }), width), /♨ miss/, `width ${width}`);
});

test("cold with an ending keeps it; a running turn and a cleared ending show the usual count", () => {
  assert.match(line(src({ endedBy: "miss", now: T0 + 400_000 })), /cold ♨ miss$/);
  assert.match(line(src({ endedBy: "miss", running: true })), / ♨ 4 ½$/);
  assert.match(line(src({ endedBy: null, warmsLeft: 3, nextWarmAt: T0 + 270_000 })), / ♨ 3 ½$/);
  assert.match(line(src({})), / ♨ 0 ½$/);
});

test("no bar, no ending: a policy that does not warm hides it", () => {
  assert.equal(cacheViewOf(src({ endedBy: "miss", enabled: false })), null);
});
