/**
 * `/foreman cost --json`: usage records priced by role, model and role×model (pure, no session needed).
 * A record's own non-zero cost is "recorded"; otherwise it is "repriced" from config/prices.json
 * (Haiku 5.5's long_context tier per request, as cost.ts), or "unpriced" when the table has no rate.
 */
import { priceRecord, tableRate } from "./cost.ts";
import type { PriceTable } from "./cost.ts";
import { isCostLine, type UsageLine } from "./usage.ts";

export interface CostRow {
  role?: string;
  model?: string;
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** USD rounded to the cent. */
  usd: number;
  recorded: number;
  repriced: number;
  unpriced: number;
  /** Repriced calls that used the long_context tier. */
  longContext: number;
  /** Calls whose token counts are a character estimate. */
  estimatedTokens: number;
}

export interface CostReport {
  scope: string;
  byRole: CostRow[];
  byModel: CostRow[];
  byRoleModel: CostRow[];
  total: CostRow;
  keepalive: { calls: number; usd: number };
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
export const cents = (x: number): number => Math.round(x * 100 + 1e-9) / 100;

type Acc = { row: CostRow; raw: number };
const mk = (role?: string, model?: string): Acc => ({
  raw: 0,
  row: { ...(role !== undefined ? { role } : {}), ...(model !== undefined ? { model } : {}), calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0, recorded: 0, repriced: 0, unpriced: 0, longContext: 0, estimatedTokens: 0 },
});

export function costReport(lines: UsageLine[], prices: PriceTable | null, scope = "session"): CostReport {
  const maps = { role: new Map<string, Acc>(), model: new Map<string, Acc>(), rm: new Map<string, Acc>() };
  const total = mk();
  const ka = { calls: 0, raw: 0 };
  const get = (m: Map<string, Acc>, k: string, role?: string, model?: string): Acc => {
    let a = m.get(k);
    if (!a) m.set(k, (a = mk(role, model)));
    return a;
  };
  for (const l of lines) {
    if (!isCostLine(l)) continue;
    const p = priceRecord(l, prices);
    if (l.kind === "keepalive") {
      ka.calls += 1;
      ka.raw += p.cost.total;
      continue;
    }
    const model = l.provider && l.model ? `${l.provider}/${l.model}` : l.model ?? "(unknown)";
    const prompt = n(l.input) + n(l.cacheRead) + n(l.cacheWrite);
    const lc = p.estimated && (tableRate(prices, l.model, prompt)?.input ?? 0) !== (tableRate(prices, l.model, 0)?.input ?? 0);
    const tokens = prompt + n(l.output);
    const src: "recorded" | "repriced" | "unpriced" = p.estimated ? "repriced" : p.cost.total !== 0 || tokens === 0 ? "recorded" : "unpriced";
    for (const a of [get(maps.role, l.role, l.role), get(maps.model, model, undefined, model), get(maps.rm, `${l.role}\u0000${model}`, l.role, model), total]) {
      a.row.calls += 1;
      a.row.input += n(l.input);
      a.row.cacheRead += n(l.cacheRead);
      a.row.cacheWrite += n(l.cacheWrite);
      a.row.output += n(l.output);
      a.raw += p.cost.total;
      a.row[src] += 1;
      if (lc) a.row.longContext += 1;
      if (l.estimated === true) a.row.estimatedTokens += 1;
    }
  }
  const rows = (m: Map<string, Acc>): CostRow[] =>
    [...m.entries()]
      .sort((x, y) => (x[0] < y[0] ? -1 : 1))
      .map(([, a]) => ({ ...a.row, usd: cents(a.raw) }));
  return { scope, byRole: rows(maps.role), byModel: rows(maps.model), byRoleModel: rows(maps.rm), total: { ...total.row, usd: cents(total.raw) }, keepalive: { calls: ka.calls, usd: cents(ka.raw) } };
}
