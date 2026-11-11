// Warm budget (docs/cache.md): per idle stretch, the warms may cost at most a tier share (`budgetShare` for the half tier,
// half of it for the quarter tier) x one cold re-cache of the prompt, priced at max(cacheWrite, input). Pure: no Pi imports. Counts tokens, not dollars, so `spent` is repriced with the same rates as
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
/** A cold re-cache is priced at max(cacheWrite, input): a model without a cache-write rate still has a price when its input rate is known. */
const usable = (r: Rate | null | undefined): r is Rate => !!r && Math.max(num(r.cacheWrite), num(r.input)) > 0;

/** Rates for the budget: the price table first, else the registry's cost (one cacheWrite rate for any TTL); null = unavailable. */
export function warmRates(o: { table?: PriceTable | null; registry?: Rate | null; model: string | null; promptTokens: number; ttlSeconds: number | null }): Rates | null {
  const t = tableRate(o.table, o.model, o.promptTokens, (o.ttlSeconds ?? 0) >= 3600);
  const r = usable(t) ? t : usable(o.registry) ? o.registry : null;
  return r ? { input: num(r.input), output: num(r.output), cacheRead: num(r.cacheRead), cacheWrite: num(r.cacheWrite) } : null;
}

/** A completed warm read the cache: cacheRead above 0 and not less than what it wrote (the miss rule of selfwarm.ts). */
export const warmHit = (t: Pick<WarmTokens, "cacheRead" | "cacheWrite">): boolean => num(t.cacheRead) > 0 && num(t.cacheWrite) < num(t.cacheRead);

export interface BudgetCheck {
  ok: boolean;
  spent: number;
  cold: number;
  next: number;
}

export class WarmBudget {
  private prompt = 0;
  private warms: WarmTokens[] = [];
  /** The last completed warm that hit the cache and the prompt size it ran at; survives a reset (a new stretch has no warm yet). A miss never sets it. */
  private lastWarm: { tokens: WarmTokens; prompt: number } | null = null;

  /** A real request ended (prompt = its input + cacheRead + cacheWrite), a compaction ran or the model changed: a new idle. */
  reset(promptTokens = 0): void {
    this.prompt = promptTokens;
    this.warms = [];
  }

  promptTokens(): number {
    return this.prompt;
  }

  note(t: WarmTokens): void {
    const w = { input: num(t.input), output: num(t.output), cacheRead: num(t.cacheRead), cacheWrite: num(t.cacheWrite) };
    this.warms.push(w);
    if (warmHit(w)) this.lastWarm = { tokens: w, prompt: this.prompt };
  }

  /** The cost of the last measured hit of the session, its prompt tokens scaled to the current prompt size when that changed; null = none yet. */
  private measured(rates: Rates): number | null {
    const l = this.lastWarm;
    if (!l) return null;
    const k = l.prompt > 0 && this.prompt > 0 ? this.prompt / l.prompt : 1;
    const t = l.tokens;
    return costAt({ input: t.input * k, output: t.output, cacheRead: t.cacheRead * k, cacheWrite: t.cacheWrite * k }, rates).total;
  }

  /** Null when there is no prompt size or no rate (budget unavailable). `cold` = P x max(cacheWrite, input); `next` = the measured cost of the last warm of the session that hit the cache (this stretch or an earlier one), else P x cacheRead + 1 output token. */
  check(rates: Rates | null, share: number): BudgetCheck | null {
    if (!rates || this.prompt <= 0) return null;
    const spent = this.warms.reduce((a, w) => a + costAt(w, rates).total, 0);
    const cold = (this.prompt * Math.max(rates.cacheWrite, rates.input)) / 1e6;
    const next = this.measured(rates) ?? costAt({ cacheRead: this.prompt, output: 1 }, rates).total;
    return { ok: spent + next <= share * cold, spent, cold, next };
  }
}
