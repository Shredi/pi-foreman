// Prompt-cache policy of one provider (idle-cache). Pure: no Pi imports.
// Mirrors cache_policy / BUILTIN_CACHE in scripts/foreman_config.py.

/** Pi's own idle limit: pings past it are pointless. */
export const PI_IDLE_CAP_MINUTES = 30;

export type CacheBilling = "token" | "request";

/** Built-in cache values per provider; a config key wins per key. */
export const BUILTIN_CACHE: Record<string, { ttlSeconds: number | null; billing: CacheBilling }> = {
  "claude-bridge": { ttlSeconds: 300, billing: "token" },
  "github-copilot": { ttlSeconds: null, billing: "request" },
};

/** Built-in per-model TTLs of a provider (seconds); the first matching row wins, after a config row and ttlSeconds. */
export const BUILTIN_BY_MODEL: Record<string, { match: string; ttlSeconds: number }[]> = {
  "github-copilot": [
    { match: "claude-*", ttlSeconds: 300 },
    { match: "gpt-*", ttlSeconds: 1800 },
    { match: "o1*", ttlSeconds: 1800 },
    { match: "o3*", ttlSeconds: 1800 },
    { match: "o4*", ttlSeconds: 1800 },
  ],
};

export type CacheSkip = "no_entry" | "billing_request" | "ttl_unknown" | "ttl_long" | "disabled";

export interface CachePolicy {
  active: boolean;
  skip?: CacheSkip;
  ttlSeconds: number | null;
  billing: CacheBilling | null;
  intervalSeconds: number;
  windowMinutes: number;
  effectiveWindowMinutes: number;
  warmCompact: boolean;
  // Warm policy (resolveWarmPolicy); an absent field keeps the old behaviour.
  /** Per-idle warm spend cap as a share of a cold re-cache; absent = no budget. */
  budgetShare?: number;
  /** Warms allowed while the owner is away (presence.ts). Absent = presence ignored. */
  awayTicks?: number;
  /** Children, waits and launch waits do not count as busy for warming. Absent = they do. */
  whileWaiting?: boolean;
  /** pi-foreman sends the warms itself beyond Pi's idle cap (selfwarm.ts). Absent = off. */
  selfWarm?: boolean;
  selfWarmWindowMinutes?: number;
  /** Smallest context (tokens) a warm compaction runs at; 0 = no minimum. Absent = 0. */
  compactMinTokens?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** Glob (`*`, `?`) or substring match of a byModel row on the model id. */
export function matchModel(pattern: string, model: string): boolean {
  if (!/[*?]/.test(pattern)) return model.includes(pattern);
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`).test(model);
}

/**
 * `model` is the bare model id or `<provider>/<id>`. TTL order: a matching byModel row, an explicit ttlSeconds,
 * on claude-bridge `bridgeTtlS` (derivedBridgeTtlS), the built-in per-model row, the provider built-in.
 */
export function resolveCachePolicy(config: unknown, provider: string | undefined | null, model?: string | null, bridgeTtlS?: number | null): CachePolicy {
  return resolve(config, provider, model, bridgeTtlS).policy;
}

function resolve(config: unknown, provider: string | undefined | null, model?: string | null, bridgeTtlS?: number | null): { policy: CachePolicy; enabled: boolean } {
  const provs = isObj(config) ? config.providers : undefined;
  const entry = isObj(provs) && provider ? provs[provider] : undefined;
  const raw = isObj(entry) ? entry.cache : undefined;
  const cfg = isObj(raw) ? raw : {};
  const built = provider && Object.prototype.hasOwnProperty.call(BUILTIN_CACHE, provider) ? BUILTIN_CACHE[provider] : undefined;
  const ka = isObj(cfg.keepalive) ? cfg.keepalive : {};

  const id = model ? (model.startsWith(`${provider}/`) ? model.slice(String(provider).length + 1) : model) : "";
  const row = id && Array.isArray(cfg.byModel)
    ? cfg.byModel.find((r) => isObj(r) && typeof r.match === "string" && r.match !== "" && matchModel(r.match, id))
    : undefined;
  const hit = isObj(row) ? row : {};
  const rows = provider && Object.prototype.hasOwnProperty.call(BUILTIN_BY_MODEL, provider) ? BUILTIN_BY_MODEL[provider] : [];
  const derived = !isInt(hit.ttlSeconds) && !("ttlSeconds" in cfg) && provider === "claude-bridge" && isInt(bridgeTtlS);
  const ttlRaw = isInt(hit.ttlSeconds)
    ? hit.ttlSeconds
    : "ttlSeconds" in cfg
      ? cfg.ttlSeconds
      : derived
        ? bridgeTtlS
        : (id ? rows.find((r) => matchModel(r.match, id))?.ttlSeconds : undefined) ?? built?.ttlSeconds;
  const ttlSeconds = isInt(ttlRaw) && ttlRaw >= 1 ? ttlRaw : null;
  const billingRaw = hit.billing === "token" || hit.billing === "request" ? hit.billing : cfg.billing;
  const billing: CacheBilling | null =
    billingRaw === "token" || billingRaw === "request" ? billingRaw : (built?.billing ?? null);
  const intervalSeconds = isInt(ka.intervalSeconds)
    ? Math.min(3600, Math.max(30, ka.intervalSeconds))
    : Math.max(30, Math.round((ttlSeconds ?? 0) * 0.9));
  const windowMinutes = isInt(ka.windowMinutes) ? Math.min(60, Math.max(1, ka.windowMinutes)) : 45;
  const base = {
    ttlSeconds,
    billing,
    intervalSeconds,
    windowMinutes,
    effectiveWindowMinutes: Math.min(windowMinutes, PI_IDLE_CAP_MINUTES),
    warmCompact: typeof cfg.warmCompact === "boolean" ? cfg.warmCompact : true,
  };
  if (!built && Object.keys(cfg).length === 0) return { policy: { ...base, active: false, skip: "no_entry" }, enabled: false };

  // A derived bridge TTL keeps keep-alive on by default, also at 3600 s (the warms are then self-warms).
  const enabled =
    typeof ka.enabled === "boolean" ? ka.enabled : billing === "token" && ttlSeconds !== null && (ttlSeconds < 3600 || derived);
  let skip: CacheSkip | undefined;
  if (billing === "request") skip = "billing_request";
  else if (ttlSeconds === null) skip = "ttl_unknown";
  else if (ttlSeconds >= 3600) skip = "ttl_long";
  else if (!enabled) skip = "disabled";
  return { policy: skip ? { ...base, active: false, skip } : { ...base, active: true }, enabled };
}

/** Smallest TTL Pi could not warm twice before its idle cap (two 0.9 x TTL ticks): the self-warmer owns every such cache. */
export const SELF_WARM_MIN_TTL_SECONDS = Math.floor((PI_IDLE_CAP_MINUTES * 60) / (2 * 0.9)) + 1;

/**
 * resolveCachePolicy plus the warm-policy fields (budget, away ticks, waiting, self-warm) with their defaults.
 * A separate function: resolveCachePolicy itself keeps its pinned shape.
 */
export function resolveWarmPolicy(config: unknown, provider: string | undefined | null, model?: string | null, bridgeTtlS?: number | null): CachePolicy {
  const { policy: base, enabled } = resolve(config, provider, model, bridgeTtlS);
  if (base.skip === "no_entry") return base;
  const provs = isObj(config) ? config.providers : undefined;
  const entry = isObj(provs) && provider ? provs[provider] : undefined;
  const cfg = isObj(entry) && isObj(entry.cache) ? entry.cache : {};
  const ka = isObj(cfg.keepalive) ? cfg.keepalive : {};
  const clamp = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const ttl = base.ttlSeconds;
  const selfWarm = enabled && base.billing === "token" && ttl !== null && ka.beyondPiCap !== false && ttl >= SELF_WARM_MIN_TTL_SECONDS;
  const fallbackWindow = Math.min(1440, Math.max(45, 3 * Math.ceil((ttl ?? 0) / 60)));
  return {
    ...base,
    budgetShare: clamp(ka.budgetShare, 0, 1, 0.5),
    awayTicks: Math.trunc(clamp(ka.awayTicks, 0, 20, 0)),
    whileWaiting: typeof ka.whileWaiting === "boolean" ? ka.whileWaiting : true,
    selfWarm,
    selfWarmWindowMinutes: Math.trunc(clamp(ka.selfWarmWindowMinutes, 1, 1440, fallbackWindow)),
    compactMinTokens: Math.trunc(clamp(ka.compactMinTokens, 0, Number.MAX_SAFE_INTEGER, 100000)),
  };
}
