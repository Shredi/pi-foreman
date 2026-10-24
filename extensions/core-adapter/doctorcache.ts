// foreman doctor: idle-cache checks beyond the Pi prerequisites (docs/cache.md).
import type { CachePolicy } from "./cachepolicy.ts";

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
  if (!i.hasIdleRung) out.push(`INFO no providers.${prov}.roles.foreman.idle: the idle model downshift is off (docs/ladder.md)`);
  return out;
}
