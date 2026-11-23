// The footer's warm bar: the bar spans the whole warm time (stretch start to cold after the last allowed warm), marks sit
// between cells where the warms fire, a dashed cut says more warms come than fit, and a running turn shows a fresh stretch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheViewOf, cutGlyph, markGlyph, tierGlyphs, type CacheSource } from "../footer.ts";
import { cacheBar } from "../cachebar.ts";
import { renderFooter, visibleWidth, type FooterView } from "../footerview.ts";
import { symbolSet } from "../symbols.ts";
import type { CachePolicy } from "../cachepolicy.ts";

const plainTheme = { fg: (_c: string, t: string) => t };
const colorTheme = { fg: (c: string, t: string) => `[${c}]${t}[/]` };
const T0 = 1_700_000_000_000;
const HOUR = { ttl: 3600, tick: 3_240_000, life: 3_420_000 }; // 1 h cache: warm every 54 min, cold 57 min after a touch
const FIVE = { ttl: 300, tick: 270_000, life: 285_000 };
type Clock = typeof HOUR;
const policy = (ttl: number, over: Partial<CachePolicy> = {}): CachePolicy => ({ active: true, ttlSeconds: ttl, intervalSeconds: ttl * 0.9, windowMinutes: 45, effectiveWindowMinutes: 30, warmCompact: true, budgetShare: 0.5, awayTicks: 0, ...over });
/** An idle source `touchAfter` ms after the stretch start with `left` warms; `now` defaults to the touch. */
function idle(c: Clock, left: number, over: Partial<CacheSource> & { touchAfter?: number; at?: number } = {}): CacheSource {
  const { touchAfter = 0, at = 0, ...rest } = over;
  const touch = T0 + touchAfter;
  const now = touch + at;
  return {
    policy: policy(c.ttl), now, lastTouch: touch, stretchStartAt: T0, nextWarmAt: touch + c.tick, spanEndAt: touch + left * c.tick + c.ttl * 1000, warmsLeft: left, warmsFresh: 4, tier: "half",
    running: false, downshifted: false, idleRung: null, enabled: true, symbols: "unicode", ...rest,
  };
}
const view = (s: CacheSource): FooterView => ({ model: "m", thinking: null, branch: null, contextPercent: 10, contextWindow: 1_000_000, cacheHit: null, usage: null, statuses: [], cache: cacheViewOf(s) ?? undefined });
const line = (s: CacheSource, width = 200, theme = plainTheme): string => renderFooter(view(s), width, theme)[0];
const bar = (s: CacheSource, width = 200): string => line(s, width).split(" · ").pop()!;
const cells = (b: string): number => Array.from(b.split(" ")[0]).filter((ch) => ch === "■" || ch === "□").length;
/** The bar rendered at 5 cells: the widest line that has 5 cells. */
function bar5(s: CacheSource): string {
  for (let w = 200; w > 20; w--) {
    const b = bar(s, w);
    if (cells(b) === 5) return b;
  }
  throw new Error("no 5-cell width");
}
const count = (b: string, ch: string): number => Array.from(b.split(" ")[0]).filter((x) => x === ch).length;

test("goldens at 10 cells: all warms fit, marks between cells, the fill stays visible", () => {
  assert.equal(bar(idle(HOUR, 9)), "■│■│■│■│■│■│■│■│■│■ 9h ♨ ½");
  // 4 of 9 warms done: the touch moved to the fourth warm, the stretch started at T0
  assert.equal(bar(idle(HOUR, 5, { touchAfter: 4 * HOUR.tick })), "■│■│■│■│■│■□□□□ 5h ♨ ½");
  assert.equal(bar(idle(HOUR, 2, { tier: "quarter" })), "■■■│■■■■│■■■ 2h ♨ ¼");
  assert.equal(bar(idle(HOUR, 1)), "■■■■■│■■■■■ 1h ♨ ½"); // the warm fires 3240 s ahead of 6660 s
});

test("warm counts 0, 1, 2, 3: no marks for 0, one mark each otherwise", () => {
  assert.equal(count(bar(idle(HOUR, 0)), "│"), 0);
  for (const n of [1, 2, 3]) assert.equal(count(bar(idle(HOUR, n)), "│"), n, `${n} warms`);
  // 1 warm: end = cold + 1 tick, the warm fires 3240 s ahead of 6660 s
  assert.equal(count(bar(idle(HOUR, 1)), "│"), 1);
});

test("more warms than fit: the next ones that fit, up to 3, and the dashed cut", () => {
  assert.equal(bar(idle(HOUR, 20)), "■■■■■■■■┆■│■│ 18h ♨ ½");
  assert.equal(bar(idle(FIVE, 24)), "■■■■■■■■┆■│■│ 1h ♨ ½");
  for (const [c, n] of [[HOUR, 20], [FIVE, 24], [HOUR, 12]] as const) {
    const b = bar(idle(c, n));
    assert.ok(count(b, "│") <= 3 && count(b, "│") >= 1, b);
    assert.equal(count(b, "┆"), 1, b);
    assert.ok(b.split(" ")[0].indexOf("┆") < b.split(" ")[0].indexOf("│"), `cut before the marks: ${b}`);
  }
  // a bar that fits has no cut
  assert.equal(count(bar(idle(HOUR, 9)), "┆"), 0);
});

test("5 cells: the marks re-fit", () => {
  assert.equal(count(bar5(idle(HOUR, 0)), "│"), 0);
  assert.equal(count(bar5(idle(HOUR, 1)), "│"), 1);
  assert.equal(count(bar5(idle(HOUR, 2)), "│"), 2);
  assert.equal(count(bar5(idle(HOUR, 3)), "│"), 3);
  for (const [c, n] of [[HOUR, 9], [HOUR, 20], [FIVE, 24]] as const) {
    const b = bar5(idle(c, n));
    assert.equal(cells(b), 5, b);
    assert.ok(count(b, "│") <= 3 && count(b, "┆") === 1, b);
  }
});

test("a mark and the cut add one column each", () => {
  assert.equal(visibleWidth(bar(idle(HOUR, 3)).split(" ")[0]), 10 + 3);
  const wide = idle(FIVE, 24);
  const b = bar(wide);
  assert.equal(visibleWidth(b.split(" ")[0]), 10 + 2 + 1); // 10 cells, 2 marks, the cut
  for (const w of [visibleWidth(line(wide)), visibleWidth(line(wide)) - 1, 40, 30]) assert.ok(visibleWidth(line(wide, w)) <= w, `width ${w}`);
});

test("ascii set: `|` mark, `:` cut, `1/2` and `1/4`", () => {
  const sym = symbolSet("ascii");
  assert.equal(markGlyph("ascii"), "|");
  assert.equal(cutGlyph("ascii"), ":");
  assert.equal(cutGlyph("unicode"), "┆");
  assert.equal(tierGlyphs("ascii").half, "1/2");
  assert.equal(bar(idle(FIVE, 24, { symbols: "ascii" })), `■■■■■■■■:■|■| 1h ${sym.keepalive} 1/2`);
  assert.equal(bar(idle(HOUR, 2, { symbols: "ascii", tier: "quarter" })), `■■■|■■■■|■■■ 2h ${sym.keepalive} 1/4`);
  assert.ok(!bar(idle(HOUR, 9, { symbols: "ascii" })).includes("│"));
});

test("half and quarter tier glyphs", () => {
  assert.match(bar(idle(HOUR, 3)), / ♨ ½$/);
  assert.match(bar(idle(HOUR, 3, { tier: "quarter" })), / ♨ ¼$/);
});

test("re-scale: across a warm the fill, the marks and the label stay continuous", () => {
  const before = idle(HOUR, 9, { at: HOUR.tick });
  const after = idle(HOUR, 8, { touchAfter: HOUR.tick + 3000 });
  const a = cacheViewOf(before)!;
  const b = cacheViewOf(after)!;
  assert.ok(Math.abs(a.share! - b.share!) < 0.001, `${a.share} -> ${b.share}`);
  assert.equal(a.left, b.left);
  assert.equal(a.marks!.length, 9);
  assert.equal(b.marks!.length, 8);
  b.marks!.forEach((m, i) => assert.ok(Math.abs(m - a.marks![i + 1]) < 0.001, `mark ${i}`));
});

test("re-scale: the measured-cost switch drops a second warm and the end moves in by one tick", () => {
  const end = (left: number): number => T0 + HOUR.tick + 3000 + HOUR.life + left * HOUR.tick;
  const share = (left: number): number => (end(left) - (T0 + HOUR.tick + 3000)) / (end(left) - T0);
  const normal = cacheViewOf(idle(HOUR, 8, { touchAfter: HOUR.tick + 3000 }))!;
  const measured = cacheViewOf(idle(HOUR, 7, { touchAfter: HOUR.tick + 3000 }))!;
  assert.ok(Math.abs(normal.share! - share(8)) < 1e-9);
  assert.ok(Math.abs(measured.share! - share(7)) < 1e-9);
  assert.ok(measured.share! < normal.share!);
  assert.equal(measured.left, "7h"); // (3420 + 7 x 3240) s = 7.3 h
});

test("re-scale: a tier change with another warm count re-scales", () => {
  const half = cacheViewOf(idle(HOUR, 4))!;
  const quarter = cacheViewOf(idle(HOUR, 2, { tier: "quarter" }))!;
  assert.equal(half.left, "4h"); // 3420 + 4 x 3240 = 16380 s
  assert.equal(quarter.left, "2h"); // 9900 s
  assert.equal(half.warms.tier, "half");
  assert.equal(quarter.warms.tier, "quarter");
  assert.equal(half.marks!.length, 4);
  assert.equal(quarter.marks!.length, 2);
});

test("after the last warm: the span scale continues, plain countdown, no marks, no ♨", () => {
  // the last (9th) warm landed 500 ms late; the moment before it vs the moment after
  const before = cacheViewOf(idle(HOUR, 1, { touchAfter: 8 * HOUR.tick + 500, at: HOUR.tick - 500 }))!;
  const last = idle(HOUR, 0, { touchAfter: 9 * HOUR.tick + 500, nextWarmAt: null });
  const after = cacheViewOf(last)!;
  assert.ok(Math.abs(before.share! - after.share!) < 0.001, `${before.share} -> ${after.share}`);
  assert.equal(after.left, "57:00");
  assert.deepEqual(after.marks, []);
  assert.equal(bar(last), "■□□□□□□□□□ 57:00 ½");
  // it keeps draining on the same scale
  assert.equal(bar(idle(HOUR, 0, { touchAfter: 9 * HOUR.tick, nextWarmAt: null, at: 1_710_000 })), "■□□□□□□□□□ 28:30 ½");
});

test("no warm ever sent: the bar equals today's lifetime bar", () => {
  const s = idle(HOUR, 0, { nextWarmAt: null, at: 1_000_000 });
  const life = cacheBar({ now: s.now, lastTouch: s.lastTouch, ttlSeconds: 3600, stretchStartAt: s.stretchStartAt, spanEndAt: s.spanEndAt, warmsLeft: 0, tier: "half", nextWarmAt: null }).lifeShare;
  assert.ok(Math.abs(cacheViewOf(s)!.share! - life!) < 1e-9);
  assert.deepEqual(cacheViewOf(s)!.marks, []);
});

test("stretchStartAt null: the span starts at the last touch", () => {
  const s = idle(HOUR, 5, { touchAfter: 4 * HOUR.tick, stretchStartAt: null });
  assert.equal(cacheViewOf(s)!.share, 1);
  assert.equal(cacheViewOf(s)!.left, "5h");
  // a start later than the touch falls back the same way
  assert.equal(cacheViewOf(idle(HOUR, 5, { touchAfter: 4 * HOUR.tick, stretchStartAt: T0 + 5 * HOUR.tick }))!.share, 1);
});

test("running turn with fresh warms: full bar, fresh marks, fresh total", () => {
  const s = idle(HOUR, 0, { running: true, warmsFresh: 4, nextWarmAt: null, at: 100_000 });
  const v = cacheViewOf(s)!;
  assert.equal(v.share, 1);
  assert.equal(v.left, "4h"); // 3420 + 4 x 3240 = 16380 s
  assert.equal(v.marks!.length, 4);
  assert.equal(bar(s), "■■│■■│■■│■■│■■ 4h ♨ ½");
});

test("running turn: warmsFresh 0 is the plain countdown; waiting on the owner is idle; a miss does not matter", () => {
  const plain0 = idle(HOUR, 0, { running: true, warmsFresh: 0, nextWarmAt: null });
  assert.deepEqual(cacheViewOf(plain0)!.marks ?? [], []);
  assert.equal(cacheViewOf(plain0)!.left, "57:00");
  assert.ok(!bar(plain0).includes("♨"), bar(plain0));
  const waiting = idle(HOUR, 3, { running: true, waiting: true, warmsFresh: 4 });
  assert.equal(bar(waiting), bar(idle(HOUR, 3)));
  const miss = idle(HOUR, 0, { running: true, warmsFresh: 4, endedBy: "miss", nextWarmAt: null });
  assert.equal(bar(miss), bar(idle(HOUR, 0, { running: true, warmsFresh: 4, nextWarmAt: null })));
  assert.ok(!bar(miss).includes("miss"));
  assert.equal(cacheViewOf(miss)!.marks!.length, 4);
});

test("unchanged states: miss, error, keep-alive off, ttl_long, cold, no touch", () => {
  const off = [
    idle(HOUR, 3, { endedBy: "miss" }),
    idle(HOUR, 3, { endedBy: "error" }),
    idle(HOUR, 3, { policy: policy(3600, { active: false, skip: "disabled" }) }),
    idle(HOUR, 3, { policy: policy(3600, { active: false, skip: "ttl_long" }) }),
    idle(HOUR, 3, { at: 4_000_000 }),
    idle(HOUR, 0, { lastTouch: null, nextWarmAt: null }),
    idle(HOUR, 3, { running: true, lastTouch: null, nextWarmAt: null }),
  ];
  for (const s of off) {
    const v = cacheViewOf(s)!;
    assert.deepEqual(v.marks ?? [], []);
    assert.equal(count(bar(s), "┆"), 0);
    if (s.lastTouch !== null && !v.cold) {
      const life = cacheBar({ now: s.now, lastTouch: s.lastTouch, ttlSeconds: 3600, stretchStartAt: s.stretchStartAt, spanEndAt: s.spanEndAt, warmsLeft: 0, tier: "half", nextWarmAt: null }).lifeShare;
      assert.ok(Math.abs(v.share! - life!) < 1e-9, bar(s));
    }
  }
  assert.match(bar(off[0]), /♨ miss$/);
  assert.match(bar(off[1]), /♨ err$/);
  assert.match(bar(off[4]), /cold/);
  // no touch while running: the running rule does not apply, today's output: unknown fill, the fresh `♨`, no marks
  assert.equal(bar(off[6]), "□□□□□□□□□□ ♨ ½");
});

test("colour: green while warms come, even below 50 % of the span; by lifetime after the last warm", () => {
  const near = idle(HOUR, 1, { touchAfter: 8 * HOUR.tick, at: 3_000_000 });
  assert.ok(cacheViewOf(near)!.share! < 0.2);
  assert.match(line(near, 200, colorTheme), /\[success\]■/);
  // after the last warm: 28:30 left of 57:00 is half, then 7:00 left is red
  const half = idle(HOUR, 0, { touchAfter: 9 * HOUR.tick, nextWarmAt: null, at: 1_710_000 });
  assert.match(line(half, 200, colorTheme), /\[warning\]/);
  assert.match(line(idle(HOUR, 0, { touchAfter: 9 * HOUR.tick, nextWarmAt: null, at: 2_600_000 }), 200, colorTheme), /\[warning\]/);
  assert.match(line(idle(HOUR, 0, { touchAfter: 9 * HOUR.tick, nextWarmAt: null, at: 3_000_000 }), 200, colorTheme), /\[error\]/);
  assert.match(line(idle(HOUR, 0, { touchAfter: 9 * HOUR.tick, nextWarmAt: null, at: 100_000 }), 200, colorTheme), /\[success\]/);
});
