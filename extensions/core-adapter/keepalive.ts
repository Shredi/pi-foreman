// Keep-alive usage (docs/cache.md): Pi's CacheWarmer appends a session entry
// `{type:"usage", kind:"cache_warm", usage}` per refresh and no assistant message, so `message_end` never
// sees it. syncKeepalives copies each new entry to the usage log as a `kind: "keepalive"` line (excluded from
// the footer's per-turn cost, summed as its own line by /foreman cost) and traces it. Deduped by entry id;
// the seen set is seeded from the log on the first sync, so a resumed session never double-counts.
import * as fs from "node:fs";
import { lookupRate, type PriceRegistry } from "./footer.ts";
import { appendUsage, parseLines, type LineContext, type UsageCost, type UsageLine } from "./usage.ts";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export interface KeepaliveResult {
  newEntries: number;
  /** Timestamp (ms) of the latest keep-alive entry seen so far, null when none. */
  lastReadAt: number | null;
}

export interface KeepaliveSyncOptions {
  /** `ctx.sessionManager.getEntries()`. */
  entries: unknown[];
  file: string;
  line: LineContext;
  registry?: PriceRegistry;
  trace?: (rec: Record<string, unknown>) => void;
}

/** Per session: the entry ids already in the log and the latest entry time. */
export class KeepaliveLog {
  private seen: Set<string> | null = null;
  private last: number | null = null;

  sync(o: KeepaliveSyncOptions): KeepaliveResult {
    if (!this.seen) this.seen = seedFromLog(o.file);
    let fresh = 0;
    for (const e of o.entries) {
      if (!isObj(e) || e.type !== "usage" || e.kind !== "cache_warm") continue;
      const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
      if (Number.isFinite(at)) this.last = Math.max(this.last ?? 0, at);
      const id = typeof e.id === "string" ? e.id : "";
      if (!id || this.seen.has(id)) continue;
      this.seen.add(id);
      const line = keepaliveLine(o.line, e, o.registry);
      if (!appendUsage(o.file, line)) continue;
      fresh += 1;
      o.trace?.({ event: "keepalive", outcome: "fired", cacheRead: line.cacheRead, cacheWrite: line.cacheWrite, cost: line.cost.total });
    }
    return { newEntries: fresh, lastReadAt: this.last };
  }
}

function seedFromLog(file: string): Set<string> {
  const ids = new Set<string>();
  try {
    for (const l of parseLines(fs.readFileSync(file, "utf8"))) if (l.kind === "keepalive" && typeof l.entryId === "string") ids.add(l.entryId);
  } catch {
    // no log yet
  }
  return ids;
}

/** One usage line from a cache_warm entry; cost is Pi's when non-zero, else registry rates (bridge: anthropic). */
export function keepaliveLine(ctx: LineContext, entry: Json, registry?: PriceRegistry): UsageLine {
  const u = isObj(entry.usage) ? entry.usage : {};
  const c = isObj(u.cost) ? u.cost : {};
  const provider = typeof entry.provider === "string" && entry.provider ? entry.provider : null;
  const model = typeof entry.model === "string" && entry.model ? entry.model : null;
  let cost: UsageCost = { input: num(c.input), output: num(c.output), cacheRead: num(c.cacheRead), cacheWrite: num(c.cacheWrite), total: num(c.total) };
  const tokens = num(u.input) + num(u.output) + num(u.cacheRead) + num(u.cacheWrite);
  if (cost.total === 0 && tokens !== 0) {
    const r = lookupRate(registry, provider, model);
    if (r && (num(r.input) !== 0 || num(r.output) !== 0)) {
      const m = (n: unknown, rate: unknown): number => (num(n) * num(rate)) / 1e6;
      cost = { input: m(u.input, r.input), output: m(u.output, r.output), cacheRead: m(u.cacheRead, r.cacheRead), cacheWrite: m(u.cacheWrite, r.cacheWrite), total: 0 };
      cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
    }
  }
  const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  return {
    ts: Number.isFinite(at) ? new Date(at).toISOString() : new Date().toISOString(),
    workspace: ctx.workspace,
    foremanSession: ctx.foremanSession,
    role: "foreman",
    provider,
    model,
    launchId: ctx.launchId,
    kind: "keepalive",
    stopReason: null,
    input: num(u.input),
    cacheRead: num(u.cacheRead),
    cacheWrite: num(u.cacheWrite),
    output: num(u.output),
    cost,
    entryId: typeof entry.id === "string" ? entry.id : undefined,
  };
}
