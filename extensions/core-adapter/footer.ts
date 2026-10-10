// Usage footer (item 11): one status line per Pi process from in-memory totals, refreshed after
// each assistant message_end. Cost is Pi's `usage.cost` (list price from Pi's model registry).
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
export function addMessage(t: FooterTotals, message: unknown, registry?: PriceRegistry): void {
  const m = (message && typeof message === "object" ? message : {}) as Json;
  const u = (m.usage && typeof m.usage === "object" ? m.usage : {}) as Json;
  const c = (u.cost && typeof u.cost === "object" ? u.cost : {}) as Json;
  t.input += num(u.input);
  t.cacheRead += num(u.cacheRead);
  t.cacheWrite += num(u.cacheWrite);
  t.output += num(u.output);
  if (num(c.total) === 0 && num(u.input) + num(u.output) + num(u.cacheRead) + num(u.cacheWrite) !== 0) {
    // claude-bridge (and any provider that reports no cost): list price from the registry, anthropic rates for the bridge.
    const rate = lookupRate(registry, m.provider, m.model);
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
export function footerText(t: FooterTotals, children: number | null): string {
  const up = t.input + t.cacheRead + t.cacheWrite;
  const base = `↑${abbrev(up)} ↓${abbrev(t.output)} tok · ${money(t.cost, t.unpriced)} list (warm ${money(t.costCacheRead, t.unpriced)} / cold ${money(t.costCold, t.unpriced)})`;
  return children === null ? base : `${base} · children ${children}`;
}

export interface FooterCtx {
  mode?: string;
  modelRegistry?: PriceRegistry;
  ui: { setStatus(key: string, text: string | undefined): void };
}

/** Per-session totals; `update` never throws and does nothing unless enabled in a tui/rpc session. */
export class UsageFooter {
  private totals = new Map<string, FooterTotals>();

  update(sessionId: string, ctx: FooterCtx, message: unknown, opts: { enabled: unknown; isChild: boolean; children: number }): void {
    try {
      const t = this.totals.get(sessionId) ?? zeroTotals();
      this.totals.set(sessionId, t);
      addMessage(t, message, ctx.modelRegistry);
      if (opts.enabled !== true || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return;
      ctx.ui.setStatus(FOOTER_KEY, footerText(t, opts.isChild ? null : opts.children));
    } catch {
      // the footer is cosmetic
    }
  }

  /** The footer's own numbers (in = input + cache read + cache write, out = output) and list-price cost; null before any message. */
  totalsOf(sessionId: string): { tokensIn: number; tokensOut: number; cost: number } | null {
    const t = this.totals.get(sessionId);
    return t ? { tokensIn: t.input + t.cacheRead + t.cacheWrite, tokensOut: t.output, cost: t.cost } : null;
  }

  drop(sessionId: string): void {
    this.totals.delete(sessionId);
  }
}
