// The numbers of the footer's cache bar (docs/cache.md, "Footer bar"): time to cold, share left, warms still to come
// and what limits them. Pure: no Pi imports; the adapter hands in state it already holds.
import { coldAt } from "./warmcompact.ts";

export type CacheLimiter = "window" | "budget" | "away";

export interface CacheSnapshot {
  now: number;
  /** Latest cache touch (request end or completed warm), ms; null = none (the cache is cold). */
  lastTouch: number | null;
  ttlSeconds: number;
  /** When the next warm is sent, ms; null = no warm pending. */
  nextWarmAt: number | null;
  /** The warm window closes here (ms): a warm at or after it is not sent. */
  windowEndAt: number;
  /** Time between two warms, ms. */
  tickMs: number;
  /** Budget check of the warm policy (warmbudget.ts) with its share; null = no budget or unavailable. */
  budget: { spent: number; cold: number; next: number; share: number } | null;
  /** Presence gate: null = presence ignored. */
  away: { isAway: boolean; used: number; ticks: number } | null;
}

export interface CacheBar {
  /** Absolute time the cache is taken as cold; null without a touch. */
  coldAt: number | null;
  /** Ms until cold, never negative; null without a touch. */
  leftMs: number | null;
  /** Share of the touch-to-cold span still ahead, 0..1; null without a touch. */
  share: number | null;
  warmsLeft: number;
  /** What ends the warms; null when none is pending. */
  limiter: CacheLimiter | null;
}

export function cacheBar(s: CacheSnapshot): CacheBar {
  const cold = s.lastTouch === null ? null : coldAt(s.lastTouch, s.ttlSeconds);
  const leftMs = cold === null ? null : Math.max(0, cold - s.now);
  const span = cold === null || s.lastTouch === null ? 0 : cold - s.lastTouch;
  const share = leftMs === null ? null : span > 0 ? Math.min(1, leftMs / span) : 0;
  if (s.nextWarmAt === null) return { coldAt: cold, leftMs, share, warmsLeft: 0, limiter: null };

  const first = s.nextWarmAt;
  const byWindow = s.windowEndAt > first ? (s.tickMs > 0 ? Math.ceil((s.windowEndAt - first) / s.tickMs) : 1) : 0;
  let byBudget = Infinity;
  if (s.budget && s.budget.next > 0) byBudget = Math.max(0, Math.floor((s.budget.share * s.budget.cold - s.budget.spent) / s.budget.next + 1e-9));
  const byAway = s.away && s.away.isAway ? Math.max(0, s.away.ticks - s.away.used) : Infinity;

  const warmsLeft = Math.min(byWindow, byBudget, byAway);
  const limiter: CacheLimiter = byWindow <= byBudget && byWindow <= byAway ? "window" : byBudget <= byAway ? "budget" : "away";
  return { coldAt: cold, leftMs, share, warmsLeft, limiter };
}

/** mm:ss, h:mm:ss above an hour. */
export function formatLeft(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${String(m).padStart(2, "0")}:${sec}`;
}
