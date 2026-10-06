// Compaction per price tier (item 12): compact earlier on expensive models. Pi's own reserveTokens
// threshold stays as the backstop. ctx.compact() goes through AgentSession.compact(), which runs the
// session_before_compact hooks (the claude-bridge gate in index.ts included).
export type PriceClass = "cheap" | "standard" | "premium";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** `model.cost.input` is USD per million input tokens in Pi's registry. Unknown cost -> standard. */
export function priceClass(model: { cost?: { input?: unknown } } | null | undefined, tiers: unknown): PriceClass {
  const cost = model?.cost?.input;
  const t = (tiers && typeof tiers === "object" ? tiers : {}) as Record<string, unknown>;
  if (!isNum(cost) || !isNum(t.cheap) || !isNum(t.standard)) return "standard";
  return cost < t.cheap ? "cheap" : cost < t.standard ? "standard" : "premium";
}

export interface ContextUsageLike {
  tokens: number | null;
  contextWindow: number;
}

/** True when usage is known and above `fraction` of the window. */
export function overThreshold(u: ContextUsageLike | null | undefined, fraction: unknown): boolean {
  return !!u && isNum(u.tokens) && isNum(u.contextWindow) && u.contextWindow > 0 && isNum(fraction) && u.tokens > fraction * u.contextWindow;
}

/** Once-per-crossing latch per session: reset on session_compact / session_compact_failed. */
export class CompactionGate {
  private requested = new Set<string>();

  /** The price class to trace when a compaction should be requested now, else null (and the latch is set). */
  decide(sessionId: string, model: { cost?: { input?: unknown } } | null | undefined, usage: ContextUsageLike | null | undefined, config: { tiers: unknown; thresholds: unknown }): PriceClass | null {
    if (this.requested.has(sessionId)) return null;
    const cls = priceClass(model, config.tiers);
    const th = (config.thresholds && typeof config.thresholds === "object" ? config.thresholds : {}) as Record<string, unknown>;
    if (!overThreshold(usage, th[cls])) return null;
    this.requested.add(sessionId);
    return cls;
  }

  reset(sessionId: string): void {
    this.requested.delete(sessionId);
  }
}
