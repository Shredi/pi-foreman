// Idle warm compaction gate (item 7). Pi's own auto-compaction decides when a session compacts (the point is
// written by `foreman setup` as compaction.modelOverrides); pi-foreman only spends the last warm cache read
// on one compaction while a foreman session idles, from half the runtime point. ctx.compact() goes through
// AgentSession.compact(), which runs the session_before_compact hooks (the claude-bridge gate in index.ts included).
export interface ContextUsageLike {
  tokens: number | null;
  contextWindow: number;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Idle-cache warm compaction compacts from this share of the runtime compaction point. */
export const IDLE_FLOOR_FACTOR = 0.5;

/** True when usage is known and above `IDLE_FLOOR_FACTOR * point` tokens; false for an unknown point. */
export function overIdleFloor(u: ContextUsageLike | null | undefined, point: number | null | undefined): boolean {
  return !!u && isNum(u.tokens) && isNum(point) && point > 0 && u.tokens > point * IDLE_FLOOR_FACTOR;
}

/** Once-per-crossing latch per session: reset on session_compact / session_compact_failed. */
export class CompactionGate {
  private requested = new Set<string>();

  /** True when a warm compaction should be requested now (and the latch is set); false when latched or below the floor. */
  decideIdle(sessionId: string, usage: ContextUsageLike | null | undefined, point: number | null | undefined): boolean {
    if (this.requested.has(sessionId)) return false;
    if (!overIdleFloor(usage, point)) return false;
    this.requested.add(sessionId);
    return true;
  }

  reset(sessionId: string): void {
    this.requested.delete(sessionId);
  }
}
