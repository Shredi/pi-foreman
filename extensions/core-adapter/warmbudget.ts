// Warm budget (docs/cache.md): per idle, the warms may cost at most `budgetShare` x one cold re-cache of the
// prompt. Pure: no Pi imports. Counts tokens, not dollars, so `spent` is repriced with the same rates as
// `cold` (config/prices.json first, else the registry cost; the 1h write rate when the TTL is 3600 s or more).
import { costAt, tableRate, type PriceTable, type Rate } from "./cost.ts";

export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface WarmTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const usable = (r: Rate | null | undefined): r is Rate => !!r && num(r.cacheWrite) > 0;

/** Rates for the budget: the price table first, else the registry's cost (one cacheWrite rate for any TTL); null = unavailable. */
export function warmRates(o: { table?: PriceTable | null; registry?: Rate | null; model: string | null; promptTokens: number; ttlSeconds: number | null }): Rates | null {
  const t = tableRate(o.table, o.model, o.promptTokens, (o.ttlSeconds ?? 0) >= 3600);
  const r = usable(t) ? t : usable(o.registry) ? o.registry : null;
  return r ? { input: num(r.input), output: num(r.output), cacheRead: num(r.cacheRead), cacheWrite: num(r.cacheWrite) } : null;
}

export interface BudgetCheck {
  ok: boolean;
  spent: number;
  cold: number;
  next: number;
}

export class WarmBudget {
  private prompt = 0;
  private warms: WarmTokens[] = [];

  /** A real request ended (prompt = its input + cacheRead + cacheWrite), a compaction ran or the model changed: a new idle. */
  reset(promptTokens = 0): void {
    this.prompt = promptTokens;
    this.warms = [];
  }

  promptTokens(): number {
    return this.prompt;
  }

  note(t: WarmTokens): void {
    this.warms.push({ input: num(t.input), output: num(t.output), cacheRead: num(t.cacheRead), cacheWrite: num(t.cacheWrite) });
  }

  /** Null when there is no prompt size or no rate (budget unavailable). `next` = last completed warm's cost, else P x cacheRead + 1 output token. */
  check(rates: Rates | null, share: number): BudgetCheck | null {
    if (!rates || this.prompt <= 0) return null;
    const spent = this.warms.reduce((a, w) => a + costAt(w, rates).total, 0);
    const cold = (this.prompt * rates.cacheWrite) / 1e6;
    const last = this.warms[this.warms.length - 1];
    const next = last ? costAt(last, rates).total : costAt({ cacheRead: this.prompt, output: 1 }, rates).total;
    return { ok: spent + next <= share * cold, spent, cold, next };
  }
}
