// The gate of the final-warm compaction (docs/cache.md), used by the self-warm: warm_compact on, not yet compacted this idle
// stretch, not busy, the cache not cold, the context above the final-warm gate (0.6 x the model's context window), then at least
// `compactMinTokens` of context. The caller's `compact()` starts ctx.compact. Pure apart from the callbacks.
import type { CachePolicy } from "./cachepolicy.ts";

/** A cache older than this share of its TTL counts as cold. */
export const COLD_SHARE = 0.95;

/** Absolute time (ms) the cache is taken as cold: `lastTouch` + 0.95 x TTL. */
export const coldAt = (lastTouch: number, ttlSeconds: number): number => lastTouch + COLD_SHARE * ttlSeconds * 1000;

export type CompactTrigger = "final_warm";

export interface WarmCompactArgs {
  policy: CachePolicy | null;
  alreadyCompacted: boolean;
  /** True when a turn runs or a message is queued (evaluated after the cheap gates, before the cold check). */
  busy(): boolean;
  now: number;
  /** Latest cache touch (real request end, completed warm) in ms; 0 = unknown. */
  lastTouch: number;
  /** Context tokens of the session (the count the idle floor reads); null/absent = unknown, the minimum does not apply. */
  contextTokens?: () => number | null;
  /** The context is above the final-warm gate (0.6 x context window); checked before the minimum. Absent = the gate is left to compact(). */
  aboveFloor?: () => boolean;
  compact(): { point: number | null; model: string | null } | null;
  trace(r: Record<string, unknown>): void;
  /** Set on the final-warm trigger; absent keeps the plain trace shape. */
  trigger?: CompactTrigger;
  /** Legacy skip traces are `keepalive window_end <reason>`; the refusal triggers use `keepalive skipped <reason>`. */
  skipOutcome?: "window_end" | "skipped";
}

/** True when the compaction was started. */
export function warmCompact(a: WarmCompactArgs): boolean {
  const skip = (reason: string): false => {
    a.trace({ event: "keepalive", outcome: a.skipOutcome ?? "window_end", reason });
    return false;
  };
  const p = a.policy;
  if (!p || !p.warmCompact) return skip("warm_compact_off");
  if (a.alreadyCompacted) return skip("already_compacted");
  if (a.busy()) return skip("busy");
  if (p.ttlSeconds === null || a.lastTouch === 0 || a.now > coldAt(a.lastTouch, p.ttlSeconds)) return skip("cold");
  if (a.aboveFloor && !a.aboveFloor()) return skip("below_floor");
  const min = p.compactMinTokens ?? 0;
  const tokens = a.contextTokens?.() ?? null;
  if (min > 0 && tokens !== null && tokens < min) {
    a.trace({ event: "compaction_skipped", reason: "below_min", tokens, min, ...(a.trigger ? { trigger: a.trigger } : {}) });
    return false;
  }
  const fired = a.compact();
  if (!fired) return skip("below_floor");
  a.trace({ event: "compaction", reason: "warm_idle", point: fired.point, model: fired.model, ...(a.trigger ? { trigger: a.trigger } : {}) });
  return true;
}
