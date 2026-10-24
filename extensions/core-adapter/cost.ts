// Priced cost of a usage record (R6 lane 3). The claude-bridge logs `cost.total: 0`, so a record
// without a cost is priced from the model registry's rate when that is non-zero, else from the
// list-price table config/prices.json (the bench's table: input, output, cache read, cache write at
// the 5-minute rate; a model's `long_context` row replaces the base row for a request whose prompt
// tokens input + cacheRead + cacheWrite are above its `above`). Such a cost is an estimate.
import * as fs from "node:fs";
import * as path from "node:path";

/** USD per million tokens (the registry's shape). */
export interface Rate {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface Row {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write_5m?: number;
  cache_write_1h?: number;
}
interface PriceRow extends Row {
  long_context?: Row & { above?: number };
}
export interface PriceTable {
  models: Record<string, PriceRow>;
}

export interface Tokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}
export interface Priced {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

let cached: { file: string; table: PriceTable | null } | null = null;

/** config/prices.json of the package (cached per file); null when missing or malformed. */
export function loadPrices(pkgRoot: string): PriceTable | null {
  const file = path.join(pkgRoot, "config", "prices.json");
  if (cached?.file === file) return cached.table;
  let table: PriceTable | null = null;
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (v && typeof v === "object" && (v as { models?: unknown }).models && typeof (v as { models: unknown }).models === "object") table = v as PriceTable;
  } catch {
    // no table: records without a cost stay unpriced
  }
  cached = { file, table };
  return table;
}

/** The table's rate for a model id (provider prefix and a date suffix are tolerated) and one request's prompt size. */
export function tableRate(table: PriceTable | null | undefined, model: unknown, promptTokens: number, longWrite = false): Rate | null {
  if (!table || typeof model !== "string" || !model) return null;
  const bare = model.slice(model.lastIndexOf("/") + 1);
  let row = table.models[bare];
  if (!row) {
    const key = Object.keys(table.models).filter((k) => bare.startsWith(k + "-")).sort((a, b) => b.length - a.length)[0];
    row = key ? table.models[key] : undefined;
  }
  if (!row) return null;
  const lc = row.long_context;
  const t: Row = lc && promptTokens > num(lc.above) ? lc : row;
  return { input: num(t.input), output: num(t.output), cacheRead: num(t.cache_read), cacheWrite: num(longWrite && t.cache_write_1h !== undefined ? t.cache_write_1h : t.cache_write_5m) };
}

export function costAt(tokens: Tokens, rate: Rate): Priced {
  const m = (n: unknown, r: unknown): number => (num(n) * num(r)) / 1e6;
  const c = { input: m(tokens.input, rate.input), output: m(tokens.output, rate.output), cacheRead: m(tokens.cacheRead, rate.cacheRead), cacheWrite: m(tokens.cacheWrite, rate.cacheWrite) };
  return { ...c, total: c.input + c.output + c.cacheRead + c.cacheWrite };
}

const usable = (r: Rate | null | undefined): r is Rate => !!r && (num(r.input) !== 0 || num(r.output) !== 0);

interface Record_ {
  provider?: unknown;
  model?: unknown;
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; total?: unknown } | null;
}

/** The record's own cost when non-zero, else the registry rate, else the table; `estimated` marks a computed one. */
export function priceRecord(l: Record_, table: PriceTable | null | undefined, registryRate?: Rate | null): { cost: Priced; estimated: boolean } {
  const c = l.cost && typeof l.cost === "object" ? l.cost : {};
  const own: Priced = { input: num(c.input), output: num(c.output), cacheRead: num(c.cacheRead), cacheWrite: num(c.cacheWrite), total: num(c.total) };
  const tokens: Tokens = { input: num(l.input), output: num(l.output), cacheRead: num(l.cacheRead), cacheWrite: num(l.cacheWrite) };
  if (own.total !== 0 || tokens.input! + tokens.output! + tokens.cacheRead! + tokens.cacheWrite! === 0) return { cost: own, estimated: false };
  const rate = usable(registryRate) ? registryRate : tableRate(table, l.model, tokens.input! + tokens.cacheRead! + tokens.cacheWrite!);
  return rate ? { cost: costAt(tokens, rate), estimated: true } : { cost: own, estimated: false };
}
