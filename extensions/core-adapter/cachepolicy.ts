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
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

export function resolveCachePolicy(config: unknown, provider: string | undefined | null): CachePolicy {
  const provs = isObj(config) ? config.providers : undefined;
  const entry = isObj(provs) && provider ? provs[provider] : undefined;
  const raw = isObj(entry) ? entry.cache : undefined;
  const cfg = isObj(raw) ? raw : {};
  const built = provider && Object.prototype.hasOwnProperty.call(BUILTIN_CACHE, provider) ? BUILTIN_CACHE[provider] : undefined;
  const ka = isObj(cfg.keepalive) ? cfg.keepalive : {};

  const ttlRaw = "ttlSeconds" in cfg ? cfg.ttlSeconds : built?.ttlSeconds;
  const ttlSeconds = isInt(ttlRaw) && ttlRaw >= 1 ? ttlRaw : null;
  const billing: CacheBilling | null =
    cfg.billing === "token" || cfg.billing === "request" ? cfg.billing : (built?.billing ?? null);
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
  if (!built && Object.keys(cfg).length === 0) return { ...base, active: false, skip: "no_entry" };

  const enabled =
    typeof ka.enabled === "boolean" ? ka.enabled : billing === "token" && ttlSeconds !== null && ttlSeconds < 3600;
  let skip: CacheSkip | undefined;
  if (billing === "request") skip = "billing_request";
  else if (ttlSeconds === null) skip = "ttl_unknown";
  else if (ttlSeconds >= 3600) skip = "ttl_long";
  else if (!enabled) skip = "disabled";
  return skip ? { ...base, active: false, skip } : { ...base, active: true };
}
