// foreman doctor: idle-cache checks beyond the Pi prerequisites (docs/cache.md).
import type { CachePolicy } from "./cachepolicy.ts";
import { BRIDGE_TTL_ENV, forced5m, type BridgeTtlSetting, type BridgeTtlValue } from "./bridgettl.ts";

export interface CacheDoctorInput {
  provider: string | undefined;
  policy: CachePolicy;
  /** The model's `promptCache` from the registry (undefined = none declared). */
  promptCache: { short?: number; long?: number } | undefined;
  /** Pi's cache retention env value (`PI_CACHE_RETENTION`). */
  retention: string | undefined;
  /** Pi's `cacheWarming` setting is "idle". */
  cacheWarmingIdle: boolean;
  /** A self-warm miss ended the self-warm for this session (`keepalive window_end self_warm_miss`). */
  selfWarmMissed: boolean;
  /** providers.<p>.roles.foreman.idle is set. */
  hasIdleRung: boolean;
  /** The configured idle rung spec and the warm policy of its own provider; absent = no rung or not resolvable. */
  idleRung?: { spec: string; provider: string; policy: CachePolicy } | null;
}

/** WARN/INFO lines; the Pi-warm prerequisite check of the active policy stays where it was. */
export function cacheDoctorLines(i: CacheDoctorInput): string[] {
  const out: string[] = [];
  const p = i.policy;
  const prov = i.provider ?? "(none)";
  if (p.skip !== "no_entry" && p.ttlSeconds !== null && i.promptCache) {
    const tier = i.retention === "long" ? "long" : "short";
    const piTtl = i.promptCache[tier];
    if (piTtl !== p.ttlSeconds) out.push(`WARN Pi promptCache.${tier} for ${prov} is ${piTtl ?? "unset"} s but cache.ttlSeconds is ${p.ttlSeconds}: Pi warms and expires on its own tier, the budget and cold checks on the policy's — make them equal in models.json or providers.${prov}.cache (docs/cache.md)`);
  }
  if (p.selfWarm && !p.active && !i.cacheWarmingIdle) out.push(`WARN Pi cacheWarming is not "idle": the warms for ${prov} (TTL ${p.ttlSeconds} s) are not sent — set "cacheWarming": "idle" in Pi's settings.json (docs/cache.md)`);
  if (i.selfWarmMissed) out.push(`WARN a self-warm for ${prov} did not read the cache (keepalive window_end self_warm_miss): self-warm is off for this session — check the TTL (docs/cache.md)`);
  const r = i.idleRung;
  if (r && (r.policy.skip === "no_entry" || r.policy.ttlSeconds === null)) out.push(`WARN idle rung ${r.spec}: provider ${r.provider} has no cache entry (ttl unknown): no cache bar and no warms while downshifted — set providers.${r.provider}.cache.ttlSeconds and billing (docs/ladder.md)`);
  if (!i.hasIdleRung) out.push(`INFO no providers.${prov}.roles.foreman.idle: the idle model downshift is off (docs/ladder.md)`);
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** The note the claude-bridge presets used to write on their `claude-*` 3600 row. */
const OLD_PRESET_NOTE = "subscription within plan usage; 300 on extra-usage credits or API key";

/** Claude Code env switches that change or turn off the prompt cache the bridge turns rely on. */
export function bridgeCacheEnvLines(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  if (forced5m(env)) out.push("WARN FORCE_PROMPT_CACHING_5M is set: Claude Code ignores bridge.promptCacheTtl and caches 5 minutes; the policy assumes 300 s (docs/cache.md)");
  const off = Object.keys(env).filter((k) => k.startsWith("DISABLE_PROMPT_CACHING") && !["", "0", "false", "no", "off"].includes((env[k] ?? "").trim().toLowerCase()));
  if (off.length) out.push(`WARN ${off.sort().join(", ")} set: Claude Code turns prompt caching off for those models, so the idle cache warms nothing (docs/cache.md)`);
  return out;
}

/** INFO line with the effective claude-bridge TTL per process kind, the env WARNs and the stale-preset WARN. */
export function bridgeTtlDoctorLines(config: unknown, setting: BridgeTtlSetting, env: Record<string, string | undefined>): string[] {
  const provs = isObj(config) ? config.providers : undefined;
  const entry = isObj(provs) ? provs["claude-bridge"] : undefined;
  const cache = isObj(entry) && isObj(entry.cache) ? entry.cache : {};
  const forced = forced5m(env);
  const kind = (v: BridgeTtlValue): string => {
    if (forced) return "forced 5m (300 s)";
    if (v === "inherit") return "inherit (Claude Code's own TTL; the policy assumes 300 s)";
    return `${v} (${v === "1h" ? 3600 : 300} s)`;
  };
  const out = [`INFO bridge cache TTL: main ${kind(setting.main)}, subagent ${kind(setting.subagent)}`];
  if (typeof cache.ttlSeconds === "number") out.push(`INFO providers.claude-bridge.cache.ttlSeconds ${cache.ttlSeconds} overrides the bridge TTL above for the policy`);
  out.push(...bridgeCacheEnvLines(env));
  const staleRow = Array.isArray(cache.byModel) && cache.byModel.some((r) => isObj(r) && r.match === "claude-*" && r.ttlSeconds === 3600 && r.note === OLD_PRESET_NOTE);
  const staleTtl = cache.ttlSeconds === 300;
  if (staleRow || staleTtl) {
    const keys = [staleTtl ? "providers.claude-bridge.cache.ttlSeconds (300)" : "", staleRow ? "the claude-* 3600 byModel row" : ""].filter(Boolean).join(" and ");
    out.push(`WARN ${keys} from an earlier claude-bridge preset in your config shadows the derived bridge TTL (${BRIDGE_TTL_ENV}): delete ${staleRow && staleTtl ? "them" : "it"} from your user foreman.json (docs/cache.md)`);
  }
  return out;
}
