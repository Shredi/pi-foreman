// The numbers of the footer's cache bar (docs/cache.md, "Footer bar"): the countdown to cold, the share left of the
// current cache lifetime, the mark where the next warm fires, the warms still to come and the budget tier that allows them. Pure: no Pi imports; the
// adapter hands in state it already holds.
import { coldAt } from "./warmcompact.ts";

export type CacheTier = "half" | "quarter";

export interface CacheSnapshot {
  now: number;
  /** Latest cache touch (request end or completed warm), ms; null = none (the cache is cold). */
  lastTouch: number | null;
  ttlSeconds: number;
  /** The real request that opened the idle stretch, ms; null = none. */
  stretchStartAt: number | null;
  /** End of the TTL of the last allowed warm, ms; null = no projection. */
  spanEndAt: number | null;
  /** Warms still allowed in the active tier. */
  warmsLeft: number;
  /** Active budget tier; null = none. */
  tier: CacheTier | null;
  /** When the next warm is sent, ms; null = no warm pending. */
  nextWarmAt: number | null;
}

export interface CacheBar {
  /** Absolute time the cache is taken as cold; null without a touch. */
  coldAt: number | null;
  /** Ms until cold at the current TTL, never negative; null without a touch. */
  leftMs: number | null;
  /** Share of the projected warm span still ahead, 0..1; null without a touch. Without warms: share of the touch-to-cold span. */
  share: number | null;
  warmsLeft: number;
  /** Tier that allows the warms; null when none is pending. */
  tier: CacheTier | null;
  /** Share of the current cache lifetime (last touch until cold) still ahead, 0..1; refills at each warm; null without a touch. */
  lifeShare: number | null;
  /** Where the next warm fires on the lifetime bar, as the share of the lifetime still ahead at that moment, 0..1; null when no warm is coming. */
  markShare: number | null;
}

export function cacheBar(s: CacheSnapshot): CacheBar {
  const cold = s.lastTouch === null ? null : coldAt(s.lastTouch, s.ttlSeconds);
  const leftMs = cold === null ? null : Math.max(0, cold - s.now);
  if (cold === null || s.lastTouch === null) return { coldAt: null, leftMs: null, share: null, warmsLeft: 0, tier: null, lifeShare: null, markShare: null };
  const warming = s.nextWarmAt !== null && s.warmsLeft > 0;
  const start = warming && s.stretchStartAt !== null ? s.stretchStartAt : s.lastTouch;
  const end = warming && s.spanEndAt !== null ? s.spanEndAt : cold;
  const span = end - start;
  const share = span > 0 ? Math.max(0, Math.min(1, (end - s.now) / span)) : 0;
  const life = cold - s.lastTouch;
  const lifeShare = life > 0 ? Math.max(0, Math.min(1, (cold - s.now) / life)) : 0;
  const markShare = warming && s.nextWarmAt !== null && life > 0 ? Math.max(0, Math.min(1, (cold - s.nextWarmAt) / life)) : null;
  return { coldAt: cold, leftMs, share, warmsLeft: warming ? s.warmsLeft : 0, tier: warming ? s.tier : null, lifeShare, markShare };
}

/** The total warm time: mm:ss below 60 minutes, from 60 minutes whole hours rounded down (`1h`, `2h`). */
export function formatTotal(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return total >= 3600 ? `${Math.floor(total / 3600)}h` : formatLeft(ms);
}

/** mm:ss, h:mm:ss above an hour. */
export function formatLeft(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${String(m).padStart(2, "0")}:${sec}`;
}
