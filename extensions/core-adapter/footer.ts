// Usage footer (item 11): one status line per Pi process from in-memory totals, refreshed after
// each assistant message_end. Cost is Pi's `usage.cost` (list price from Pi's model registry).
import { tableRate } from "./cost.ts";
import type { PriceTable } from "./cost.ts";
import { symbolSet } from "./symbols.ts";
import { renderFooter } from "./footerview.ts";
import type { CacheBarView, FooterTheme, FooterView } from "./footerview.ts";
import { cacheBar, formatLeft } from "./cachebar.ts";
import type { CachePolicy } from "./cachepolicy.ts";
import { realTimers, type Timers } from "./prwatch.ts";
type Json = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export const FOOTER_KEY = "foreman-usage";

export interface FooterTotals {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  cost: number;
  costCacheRead: number;
  costCold: number;
  /** Some tokens had neither Pi cost nor a registry price (shown as n/a). */
  unpriced: boolean;
}

export interface PriceRegistry {
  find(provider: string, modelId: string): { cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } } | undefined;
}

/** Registry rates (USD per million tokens) of a message's model; the claude-bridge provider is priced at anthropic rates. */
export function lookupRate(registry: PriceRegistry | undefined, provider: unknown, model: unknown): { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined {
  try {
    return registry?.find(provider === "claude-bridge" ? "anthropic" : String(provider ?? ""), String(model ?? ""))?.cost;
  } catch {
    return undefined;
  }
}

export const zeroTotals = (): FooterTotals => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, costCacheRead: 0, costCold: 0, unpriced: false });

/** Add one assistant message's usage to the totals. */
export function addMessage(t: FooterTotals, message: unknown, registry?: PriceRegistry, table?: PriceTable | null): void {
  const m = (message && typeof message === "object" ? message : {}) as Json;
  if (m.kind === "keepalive") return; // keep-alive refreshes are summed by /foreman cost, not per turn
  const u = (m.usage && typeof m.usage === "object" ? m.usage : {}) as Json;
  const c = (u.cost && typeof u.cost === "object" ? u.cost : {}) as Json;
  t.input += num(u.input);
  t.cacheRead += num(u.cacheRead);
  t.cacheWrite += num(u.cacheWrite);
  t.output += num(u.output);
  if (num(c.total) === 0 && num(u.input) + num(u.output) + num(u.cacheRead) + num(u.cacheWrite) !== 0) {
    // claude-bridge (and any provider that reports no cost): list price from the registry, anthropic rates for the bridge.
    const reg = lookupRate(registry, m.provider, m.model);
    const rate = reg && (num(reg.input) !== 0 || num(reg.output) !== 0) ? reg : tableRate(table, m.model, num(u.input) + num(u.cacheRead) + num(u.cacheWrite)) ?? reg; // registry first, else config/prices.json (cost.ts)
    if (!rate || (num(rate.input) === 0 && num(rate.output) === 0)) {
      t.unpriced = true;
      return;
    }
    const mtok = (n: unknown, r: unknown): number => (num(n) * num(r)) / 1e6;
    const warm = mtok(u.cacheRead, rate.cacheRead);
    const cold = mtok(u.input, rate.input) + mtok(u.cacheWrite, rate.cacheWrite);
    t.cost += warm + cold + mtok(u.output, rate.output);
    t.costCacheRead += warm;
    t.costCold += cold;
    return;
  }
  t.cost += num(c.total);
  t.costCacheRead += num(c.cacheRead);
  t.costCold += num(c.input) + num(c.cacheWrite);
}

/** 999, 12.3k, 1.2M. */
export function abbrev(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1e3).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

const usd = (v: number): string => `$${v.toFixed(2)}`;
/** `n/a` when nothing is priced, `$x + n/a` when only part is. */
const money = (v: number, unpriced: boolean): string => (!unpriced ? usd(v) : v !== 0 ? `${usd(v)} + n/a` : "n/a");

/** `↑in ↓out tok · $total list (warm $x / cold $y)` plus ` · children n` when `children` is a number. */
export function footerText(t: FooterTotals, children: number | null, wait: string | null = null, runsCost: number | null = null): string {
  const up = t.input + t.cacheRead + t.cacheWrite;
  const base = `↑${abbrev(up)} ↓${abbrev(t.output)} tok · ${money(t.cost, t.unpriced)} list (warm ${money(t.costCacheRead, t.unpriced)} / cold ${money(t.costCold, t.unpriced)})`;
  // The summed estimate: the foreman's cost plus every run's priced cost (lane 3b).
  const all = runsCost !== null && runsCost > 0 ? `${base} · all ${usd(t.cost + runsCost)} est (runs ${usd(runsCost)})` : base;
  const withKids = children === null ? all : `${all} · children ${children}`;
  return wait ? `${withKids} · waiting ${wait}` : withKids;
}

/** The note of the oldest active wait (its kind when it has none), `+n` for the others; null with no waits. */
export function waitNote(waits: readonly { kind: string; note: string }[]): string | null {
  if (waits.length === 0) return null;
  const first = waits[0].note.trim() || waits[0].kind;
  return waits.length > 1 ? `${first} +${waits.length - 1}` : first;
}

export const CACHE_STATUS_KEY = "foreman-cache";

/** The keep-alive glyph while the idle window runs (undefined clears it); tui/rpc only, never throws. */
export function cacheStatus(ctx: Pick<FooterCtx, "mode" | "ui">, active: boolean, glyph: string): void {
  try {
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
    ctx.ui.setStatus(CACHE_STATUS_KEY, active ? glyph : undefined);
  } catch {
    // the footer is cosmetic
  }
}

/** Raw state behind the cache bar, read by the adapter when the footer renders (no side effects, no requests). */
export interface CacheSource {
  /** Warm policy of the current model (resolveWarmPolicy); null = none. */
  policy: CachePolicy | null;
  now: number;
  lastTouch: number | null;
  /** Window end, next warm and tick (ms) of the path that owns the warming; nextWarmAt null = no warm pending. */
  windowEndAt: number;
  nextWarmAt: number | null;
  tickMs: number;
  budget: { spent: number; cold: number; next: number; share: number } | null;
  away: { isAway: boolean; used: number; ticks: number } | null;
  /** A turn runs: the bar shows the countdown without warms. */
  running: boolean;
  downshifted: boolean;
  /** Id of the configured idle rung; null = none. */
  idleRung: string | null;
  /** `footer.cacheBar`. */
  enabled: boolean;
  /** `ui.symbols` set name. */
  symbols: string;
}

/** The bar of a source, or null when it is hidden (no entry, unknown TTL, per-request billing, switched off). */
function cacheViewOf(src: CacheSource | null): CacheBarView | null {
  const p = src?.policy;
  if (!src || !src.enabled || !p || p.billing === "request" || p.ttlSeconds === null) return null;
  if (p.skip === "no_entry" || p.skip === "ttl_unknown" || p.skip === "billing_request") return null;
  const warming = (!p.skip || (p.skip === "ttl_long" && p.selfWarm)) && !src.running;
  const bar = cacheBar({ now: src.now, lastTouch: src.lastTouch, ttlSeconds: p.ttlSeconds, nextWarmAt: warming ? src.nextWarmAt : null, windowEndAt: src.windowEndAt, tickMs: src.tickMs, budget: src.budget, away: src.away });
  const set = symbolSet(src.symbols);
  return {
    share: bar.share,
    left: bar.leftMs === null ? null : formatLeft(bar.leftMs),
    cold: !src.running && (bar.leftMs === null || bar.leftMs <= 0),
    warms: bar.warmsLeft > 0 ? { count: bar.warmsLeft, limiter: bar.limiter === "budget" || bar.limiter === "away" ? bar.limiter : null } : null,
    step: !src.downshifted ? src.idleRung : null,
    glyphs: { keepalive: set.keepalive, cold: set.cold, downshift: set.downshift },
  };
}

/** The countdown runs: a known time left that has not reached cold. */
const counting = (c: CacheBarView | null): boolean => c !== null && !c.cold && c.left !== null;

export interface FooterCtx {
  mode?: string;
  modelRegistry?: PriceRegistry;
  model?: { id: string; provider?: string; reasoning?: boolean; contextWindow?: number };
  getContextUsage?(): { percent: number | null; contextWindow: number } | undefined;
  ui: { setStatus(key: string, text: string | undefined): void };
}

/** The parts of Pi's footer data (git branch, extension statuses) the foreman footer reads. */
export interface FooterData {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
}

/** `footer.style`: "pi" keeps Pi's footer and the one-line status; any other value is the foreman footer. */
export const footerStyleOf = (value: unknown): "foreman" | "pi" => (value === "pi" ? "pi" : "foreman");

interface FooterMount {
  tui: { requestRender(): void };
  theme: FooterTheme;
  data: FooterData;
  thinking: () => string;
  ctx: FooterCtx;
  cacheSource?: (model: FooterCtx["model"]) => CacheSource | null;
}

/** Per-session totals; `update` never throws and does nothing unless enabled in a tui/rpc session. */
export class UsageFooter {
  private totals = new Map<string, FooterTotals>();
  private mounts = new Map<string, FooterMount>();
  private texts = new Map<string, string>();
  private readonly prices: PriceTable | null;
  private readonly pointOf: (model: FooterCtx["model"]) => number | null;
  private readonly timers: Timers;
  /** One 1-second re-armed timer per mounted session while the cache bar counts down. */
  private ticks = new Map<string, unknown>();

  /** `pointOf`: the compaction point Pi uses for a model (compaction-point.mjs runtimePoint), null when unknown. */
  constructor(prices: PriceTable | null = null, pointOf: (model: FooterCtx["model"]) => number | null = () => null, timers: Timers = realTimers) {
    this.prices = prices;
    this.pointOf = pointOf;
    this.timers = timers;
  }

  update(sessionId: string, ctx: FooterCtx, message: unknown, opts: { enabled: unknown; isChild: boolean; children: number; wait?: string | null; runsCost?: number }): void {
    try {
      const t = this.totals.get(sessionId) ?? zeroTotals();
      this.totals.set(sessionId, t);
      addMessage(t, message, ctx.modelRegistry, this.prices);
      const mount = this.mounts.get(sessionId);
      if (mount) mount.ctx = ctx;
      if (opts.enabled !== true || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return;
      const text = footerText(t, opts.isChild ? null : opts.children, opts.isChild ? null : opts.wait ?? null, opts.isChild ? null : opts.runsCost ?? null);
      if (!mount) {
        ctx.ui.setStatus(FOOTER_KEY, text);
        return;
      }
      this.texts.set(sessionId, text);
      mount.tui.requestRender();
      this.armTick(sessionId, mount);
    } catch {
      // the footer is cosmetic
    }
  }

  /** The footer's own numbers (in = input + cache read + cache write, out = output) and list-price cost; null before any message. */
  totalsOf(sessionId: string): { tokensIn: number; tokensOut: number; cost: number } | null {
    const t = this.totals.get(sessionId);
    return t ? { tokensIn: t.input + t.cacheRead + t.cacheWrite, tokensOut: t.output, cost: t.cost } : null;
  }

  /** Cache-read share of the session's prompt tokens (in = input + cache read + cache write); null before any prompt. */
  cacheHitOf(sessionId: string): number | null {
    const t = this.totals.get(sessionId);
    const prompt = t ? t.input + t.cacheRead + t.cacheWrite : 0;
    return t && prompt > 0 ? (t.cacheRead / prompt) * 100 : null;
  }

  /** The foreman footer of a tui session (footer.style "foreman"): Pi renders this component and it reads the live data each frame. */
  mount(sessionId: string, ctx: FooterCtx, tui: { requestRender(): void }, theme: FooterTheme, data: FooterData, thinking: () => string, cacheSource?: FooterMount["cacheSource"]): { render(width: number): string[]; invalidate(): void; dispose(): void } {
    const entry: FooterMount = { tui, theme, data, thinking, ctx, cacheSource };
    this.mounts.set(sessionId, entry);
    this.armTick(sessionId, entry);
    return {
      render: (width) => {
        try {
          const view = this.viewOf(sessionId, entry);
          this.armTick(sessionId, entry);
          return renderFooter(view, width, theme);
        } catch {
          return [this.texts.get(sessionId) ?? ""]; // the plain status segment
        }
      },
      invalidate: () => undefined,
      dispose: () => {
        if (this.mounts.get(sessionId) === entry) {
          this.mounts.delete(sessionId);
          this.stopTick(sessionId);
        }
      },
    };
  }

  private cacheOf(m: FooterMount): CacheBarView | null {
    try {
      return cacheViewOf(m.cacheSource?.(m.ctx.model) ?? null);
    } catch {
      return null; // the bar is cosmetic
    }
  }

  /** Re-render once a second while the bar counts down; only `requestRender`, no requests and no model turns. */
  private armTick(sessionId: string, m: FooterMount): void {
    if (this.ticks.has(sessionId) || this.mounts.get(sessionId) !== m || !counting(this.cacheOf(m))) return;
    this.ticks.set(sessionId, this.timers.set(() => {
      this.ticks.delete(sessionId);
      if (this.mounts.get(sessionId) !== m) return;
      try {
        m.tui.requestRender();
      } catch {
        // cosmetic
      }
      this.armTick(sessionId, m);
    }, 1000));
  }

  private stopTick(sessionId: string): void {
    if (!this.ticks.has(sessionId)) return;
    this.timers.clear(this.ticks.get(sessionId));
    this.ticks.delete(sessionId);
  }

  private viewOf(sessionId: string, m: FooterMount): FooterView {
    const model = m.ctx.model;
    const usage = m.ctx.getContextUsage?.();
    const statuses = m.data.getExtensionStatuses();
    return {
      model: model?.id ?? null,
      thinking: model?.reasoning ? m.thinking() : null,
      branch: m.data.getGitBranch(),
      contextPercent: usage?.percent ?? null,
      contextWindow: usage?.contextWindow ?? model?.contextWindow ?? 0,
      contextPoint: this.pointOf(model),
      cacheHit: this.cacheHitOf(sessionId),
      cache: this.cacheOf(m) ?? undefined,
      usage: this.texts.get(sessionId) ?? null,
      statuses: [...statuses].filter(([key]) => key !== FOOTER_KEY && key !== CACHE_STATUS_KEY).sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text),
    };
  }

  drop(sessionId: string): void {
    this.totals.delete(sessionId);
    this.texts.delete(sessionId);
    this.mounts.delete(sessionId);
    this.stopTick(sessionId);
  }
}
