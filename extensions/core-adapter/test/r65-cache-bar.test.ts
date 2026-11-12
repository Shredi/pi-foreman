// r65: the cache-timer bar of the foreman footer: goldens per symbol set, states, hidden cases, width candidates,
// colours and the once-a-second repaint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageFooter, markGlyph, tierGlyphs, type CacheSource } from "../footer.ts";
import { renderFooter, visibleWidth, type CacheBarView, type FooterView } from "../footerview.ts";
import { resolveWarmPolicy, type CachePolicy } from "../cachepolicy.ts";
import { symbolSet } from "../symbols.ts";

const CODE = { success: "32", warning: "33", error: "31", dim: "2" } as const;
const theme = { fg: (c: keyof typeof CODE, t: string) => `\x1b[${CODE[c]}m${t}\x1b[0m` };
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const MSG = { role: "assistant", usage: { input: 10000, output: 2300, cacheRead: 1_000_000, cacheWrite: 200_000, cost: { input: 0.05, output: 0.1, cacheRead: 0.5, cacheWrite: 0.25, total: 0.9 } } };

const NOW = 2_000_000_000_000;
const TTL = 3600;
const SPAN = 0.95 * TTL * 1000; // touch to cold
const TICK = 0.9 * TTL * 1000;
const RUNG = "claude-sonnet-5-5";

const policy = (over: Partial<CachePolicy> = {}): CachePolicy => ({ active: true, ttlSeconds: TTL, intervalSeconds: 3240, windowMinutes: 45, effectiveWindowMinutes: 30, warmCompact: true, selfWarm: true, ...over });

const TOUCH = NOW - (SPAN - (38 * 60 + 12) * 1000);
/** End of the TTL of the last of `n` warms, one tick apart from the touch. */
const spanEnd = (n: number): number => TOUCH + n * TICK + TTL * 1000;

/** 38:12 left to cold; 3 warms of the half tier ahead, so the span share is 12192 s of 13320 s (9 cells). */
function source(over: Partial<CacheSource> = {}): CacheSource {
  return {
    policy: policy(),
    now: NOW,
    lastTouch: TOUCH,
    stretchStartAt: TOUCH,
    nextWarmAt: NOW + 60_000,
    spanEndAt: spanEnd(3),
    warmsLeft: 3,
    tier: "half",
    running: false,
    downshifted: false,
    idleRung: RUNG,
    enabled: true,
    symbols: "unicode",
    ...over,
  };
}

/** Line 1 of a mounted footer (no branch) after one usage update, plain text. */
function line1(src: CacheSource | null, width = 300): string {
  const f = new UsageFooter();
  const ctx = { mode: "tui", model: { id: "m", reasoning: false, contextWindow: 200_000 }, getContextUsage: () => ({ percent: 10, contextWindow: 200_000 }), ui: { setStatus: () => undefined } };
  const data = { getGitBranch: () => null, getExtensionStatuses: () => new Map<string, string>() };
  const mount = f.mount("s", ctx, { requestRender: () => undefined }, theme, data, () => "off", () => src);
  f.update("s", ctx, MSG, { enabled: true, isChild: false });
  const line = plain(mount.render(width)[0]);
  mount.dispose();
  return line;
}

const HEAD = "m · ■□□□□□□□□□ 10% of 200k · CH 83% · ";

for (const which of ["unicode", "emoji", "nerd", "ascii"] as const) {
  const sym = symbolSet(which);
  const s = (over: Partial<CacheSource> = {}) => source({ symbols: which, ...over });

  test(`cache bar goldens (${which})`, () => {
    const tg = tierGlyphs(which);
    const mk = markGlyph(which);
    assert.equal(line1(s()), `${HEAD}■■■■■■■${mk}□□□ 3h ${sym.keepalive} ${tg.half} · ${sym.downshift} ${RUNG}`, "warm, 3 left");
    assert.equal(line1(s({ warmsLeft: 1, spanEndAt: spanEnd(1) })), `${HEAD}■■■■■■■${mk}□□□ 1h ${sym.keepalive} ${tg.half} · ${sym.downshift} ${RUNG}`, "last warm");
    assert.equal(line1(s({ warmsLeft: 0, spanEndAt: spanEnd(0) })), `${HEAD}■■■■■■■□□□ 38:12 ${tg.half} · ${sym.downshift} ${RUNG}`, "budget spent: counting to cold");
    assert.equal(line1(s({ warmsLeft: 1, spanEndAt: spanEnd(1), tier: "quarter" })), `${HEAD}■■■■■■■${mk}□□□ 1h ${sym.keepalive} ${tg.quarter} · ${sym.downshift} ${RUNG}`, "quarter tier");
    assert.equal(line1(s({ lastTouch: null, nextWarmAt: null })), `${HEAD}□□□□□□□□□□ ${sym.cold} cold ${tg.half} · ${sym.downshift} ${RUNG}`, "cold");
    assert.equal(line1(s({ downshifted: true })), `${HEAD}■■■■■■■${mk}□□□ 3h ${sym.keepalive} ${tg.half}`, "downshifted: no step");
    assert.equal(line1(s({ running: true })), `${HEAD}■■■■■■■□□□ 38:12 ${tg.half} · ${sym.downshift} ${RUNG}`, "running turn: no fresh count in the source = 0");
    assert.equal(line1(s({ policy: policy({ active: false, skip: "disabled" }) })), `${HEAD}■■■■■■■□□□ 38:12 ${tg.half} · ${sym.downshift} ${RUNG}`, "keep-alive disabled");
    assert.equal(line1(s({ policy: policy({ skip: "ttl_long", selfWarm: false }) })), `${HEAD}■■■■■■■□□□ 38:12 ${tg.half} · ${sym.downshift} ${RUNG}`, "ttl_long without self-warm");
    const preset = resolveWarmPolicy({ providers: { "claude-bridge": { cache: { ttlSeconds: 300, byModel: [{ match: "claude-*", ttlSeconds: 3600 }], keepalive: { enabled: true } } } } }, "claude-bridge", "claude-opus-5-5");
    assert.equal(preset.skip, "ttl_long");
    assert.equal(preset.selfWarm, true);
    assert.equal(line1(s({ policy: preset })), `${HEAD}■■■■■■■${mk}□□□ 3h ${sym.keepalive} ${tg.half} · ${sym.downshift} ${RUNG}`, "ttl_long with self-warm shows the keepalive");
    assert.equal(line1(s({ idleRung: null })), `${HEAD}■■■■■■■${mk}□□□ 3h ${sym.keepalive} ${tg.half}`, "no idle rung");
  });
}

test("a past cold deadline shows the cold state", () => {
  assert.equal(line1(source({ now: NOW + 3_600_000 })), `${HEAD}□□□□□□□□□□ ❄ cold ½ · ↓ ${RUNG}`);
});

test("hidden: no_entry, ttl_unknown, no model, footer.cacheBar false", () => {
  const bare = `${HEAD}`.slice(0, -3);
  for (const [name, src] of [
    ["no_entry", source({ policy: policy({ active: false, skip: "no_entry", ttlSeconds: null }) })],
    ["ttl_unknown", source({ policy: policy({ active: false, skip: "ttl_unknown", ttlSeconds: null }) })],
    ["no policy", source({ policy: null })],
    ["no source", null],
    ["cacheBar false", source({ enabled: false })],
  ] as const) {
    const l = line1(src);
    assert.equal(l, bare, name);
    assert.ok(!l.includes("cold") && !l.includes("warm"), name);
  }
  const f = new UsageFooter();
  const ctx = { mode: "tui", getContextUsage: () => ({ percent: 10, contextWindow: 200_000 }), ui: { setStatus: () => undefined } };
  const data = { getGitBranch: () => null, getExtensionStatuses: () => new Map<string, string>() };
  const m = f.mount("s", ctx, { requestRender: () => undefined }, theme, data, () => "off", (model) => (model ? source() : null));
  assert.ok(!plain(m.render(300)[0]).includes("38:12"), "no model");
});

const view = (cache: CacheBarView | undefined): FooterView => ({ model: "m", thinking: null, branch: "br", contextPercent: 10, contextWindow: 200_000, cacheHit: 98, usage: null, statuses: [], cache });
const glyphs = { keepalive: "♨", cold: "❄", downshift: "↓", half: "½", quarter: "¼" };
const warm: CacheBarView = { share: 0.67, left: "38:12", cold: false, warms: { count: 3, tier: "half" }, step: RUNG, glyphs };

test("the five width candidates, in order", () => {
  const c1 = `m · br · ■□□□□□□□□□ 10% of 200k · CH 98% · ■■■■■■■□□□ 38:12 ♨ ½ · ↓ ${RUNG}`;
  const c2 = `m · ■□□□□□□□□□ 10% of 200k · CH 98% · ■■■■■■■□□□ 38:12 ♨ ½ · ↓ ${RUNG}`;
  const c3 = "m · ■□□□□□□□□□ 10% of 200k · CH 98% · ■■■■■■■□□□ 38:12 ♨ ½";
  const c4 = "m · ■□□□□ 10% of 200k · CH 98% · ■■■□□ 38:12 ♨ ½";
  for (const c of [c1, c2, c3, c4]) assert.equal(plain(renderFooter(view(warm), visibleWidth(c), theme)[0]), c);
  const cut = plain(renderFooter(view(warm), visibleWidth(c4) - 4, theme)[0]);
  assert.ok(cut.endsWith("…") && cut.startsWith("m · ■□□□□ 10% of 200k"), cut);
});

test("colour codes of the cells and time at 60 / 40 / 10 % left; unknown is dim", () => {
  const code = (share: number | null): string | undefined => {
    const last = renderFooter({ ...view({ ...warm, share, step: null, warms: { count: 0, tier: null } }), cacheHit: null }, 200, theme)[0].split(" · ").pop() ?? "";
    return last.match(/^\x1b\[(\d+)m/)?.[1];
  };
  assert.equal(code(0.6), CODE.success);
  assert.equal(code(0.51), CODE.success);
  assert.equal(code(0.5), CODE.warning);
  assert.equal(code(0.4), CODE.warning);
  assert.equal(code(0.21), CODE.warning);
  assert.equal(code(0.2), CODE.error);
  assert.equal(code(0.1), CODE.error);
  assert.equal(code(null), CODE.dim);
  const cold = renderFooter(view({ ...warm, cold: true, left: null, warms: { count: 0, tier: null } }), 200, theme)[0];
  assert.ok(cold.includes(`\x1b[${CODE.error}m□□□□□□□□□□ ❄ cold`), cold);
});

test("the last warm of the quarter tier shows `last ¼`", () => {
  const l = plain(renderFooter(view({ ...warm, warms: { count: 1, tier: "quarter" } }), 300, theme)[0]);
  assert.ok(l.includes("♨ ¼"), l);
});

// ---- the once-a-second repaint ---------------------------------------------------------------------------

function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    pending,
    set(fn: () => void, ms: number): number {
      pending.set(next, { fn, ms });
      return next++;
    },
    clear(h: unknown): void {
      pending.delete(h as number);
    },
    fire(): void {
      const [[id, t]] = [...pending];
      pending.delete(id);
      t.fn();
    },
  };
}

function mounted(src: () => CacheSource | null) {
  const timers = fakeTimers();
  let renders = 0;
  const f = new UsageFooter(null, () => null, timers);
  const ctx = { mode: "tui", model: { id: "m" }, getContextUsage: () => ({ percent: 10, contextWindow: 200_000 }), ui: { setStatus: () => undefined } };
  const data = { getGitBranch: () => null, getExtensionStatuses: () => new Map<string, string>() };
  const mount = f.mount("s", ctx, { requestRender: () => void renders++ }, theme, data, () => "off", src);
  return { timers, mount, renders: () => renders, f };
}

test("the mounted footer requests a render each second while the bar counts down", () => {
  const { timers, renders } = mounted(() => source());
  assert.equal(timers.pending.size, 1);
  assert.equal([...timers.pending.values()][0].ms, 1000);
  for (let i = 1; i <= 3; i++) {
    timers.fire();
    assert.equal(renders(), i);
    assert.equal(timers.pending.size, 1);
  }
});

test("the repaint stops on dispose", () => {
  const { timers, mount, renders } = mounted(() => source());
  mount.dispose();
  assert.equal(timers.pending.size, 0);
  assert.equal(renders(), 0);
});

test("the repaint stops when the bar is hidden or cold, and starts again on the next render", () => {
  let src: CacheSource | null = source();
  const { timers, mount, renders } = mounted(() => src);
  src = source({ enabled: false });
  timers.fire();
  assert.equal(renders(), 1);
  assert.equal(timers.pending.size, 0);
  src = source();
  mount.render(80);
  assert.equal(timers.pending.size, 1);
  src = source({ lastTouch: null, nextWarmAt: null });
  timers.fire();
  assert.equal(timers.pending.size, 0);
});

test("no timer is armed for a hidden or cold bar at mount", () => {
  assert.equal(mounted(() => null).timers.pending.size, 0);
  assert.equal(mounted(() => source({ enabled: false })).timers.pending.size, 0);
  assert.equal(mounted(() => source({ lastTouch: null })).timers.pending.size, 0);
});
