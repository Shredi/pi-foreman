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
}

export const zeroTotals = (): FooterTotals => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, costCacheRead: 0, costCold: 0 });

/** Add one assistant message's usage to the totals. */
export function addMessage(t: FooterTotals, message: unknown): void {
  const m = (message && typeof message === "object" ? message : {}) as Json;
  const u = (m.usage && typeof m.usage === "object" ? m.usage : {}) as Json;
  const c = (u.cost && typeof u.cost === "object" ? u.cost : {}) as Json;
  t.input += num(u.input);
  t.cacheRead += num(u.cacheRead);
  t.cacheWrite += num(u.cacheWrite);
  t.output += num(u.output);
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

/** `↑in ↓out tok · $total list (warm $x / cold $y)` plus ` · children n` when `children` is a number. */
export function footerText(t: FooterTotals, children: number | null): string {
  const up = t.input + t.cacheRead + t.cacheWrite;
  const base = `↑${abbrev(up)} ↓${abbrev(t.output)} tok · ${usd(t.cost)} list (warm ${usd(t.costCacheRead)} / cold ${usd(t.costCold)})`;
  return children === null ? base : `${base} · children ${children}`;
}

export interface FooterCtx {
  mode?: string;
  ui: { setStatus(key: string, text: string | undefined): void };
}

/** Per-session totals; `update` never throws and does nothing unless enabled in a tui/rpc session. */
export class UsageFooter {
  private totals = new Map<string, FooterTotals>();

  update(sessionId: string, ctx: FooterCtx, message: unknown, opts: { enabled: unknown; isChild: boolean; children: number }): void {
    try {
      const t = this.totals.get(sessionId) ?? zeroTotals();
      this.totals.set(sessionId, t);
      addMessage(t, message);
      if (opts.enabled !== true || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return;
      ctx.ui.setStatus(FOOTER_KEY, footerText(t, opts.isChild ? null : opts.children));
    } catch {
      // the footer is cosmetic
    }
  }

  drop(sessionId: string): void {
    this.totals.delete(sessionId);
  }
}
