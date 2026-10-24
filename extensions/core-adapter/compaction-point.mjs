// The compaction point of a model: the context size at which Pi's own auto-compaction fires. Plain JS so
// the adapter (TS) and setup.mjs import the same code. No TS syntax here.

/** Tokens kept below a model's lowest price tier boundary. */
export const TIER_HEADROOM = 20000;
/** Pi's `compaction.reserveTokens` default. */
export const PI_DEFAULT_RESERVE = 16384;
/** Pi's `compaction.keepRecentTokens` default. */
export const PI_DEFAULT_KEEP_RECENT = 20000;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * The point `foreman setup` aims for and the reserve that produces it (reserve = window - point).
 * `write` is true only when that reserve is larger than what Pi already uses for the model, so a
 * user's own earlier-compacting setting is never overridden.
 *
 * @param {{ contextWindow: unknown, tiers?: Array<{ inputTokensAbove?: unknown }> | null }} model
 * @param {{ maxTokens?: number | null, effectiveReserve?: number, effectiveKeepRecent?: number }} [settings]
 * @returns {{ point: number | null, reserve: number | null, write: boolean, reason?: string }}
 */
export function compactionPoint(model, settings = {}) {
  const window = model?.contextWindow;
  if (!isNum(window) || window <= 0) return { point: null, reserve: null, write: false, reason: "unknown-window" };
  const effectiveReserve = isNum(settings.effectiveReserve) ? settings.effectiveReserve : PI_DEFAULT_RESERVE;
  const effectiveKeepRecent = isNum(settings.effectiveKeepRecent) ? settings.effectiveKeepRecent : PI_DEFAULT_KEEP_RECENT;
  const candidates = [window - effectiveReserve];
  const above = Array.isArray(model.tiers) ? model.tiers.map((t) => t?.inputTokensAbove).filter(isNum) : [];
  if (above.length) candidates.push(Math.min(...above) - TIER_HEADROOM);
  if (isNum(settings.maxTokens)) candidates.push(settings.maxTokens);
  const point = Math.min(...candidates);
  const reserve = window - point;
  if (reserve <= effectiveReserve) return { point, reserve, write: false, reason: "not-earlier" };
  if (point < effectiveKeepRecent + TIER_HEADROOM) return { point, reserve, write: false, reason: "below-minimum" };
  return { point, reserve, write: true };
}

/**
 * The point Pi uses right now for a model: window minus the effective reserve (per-model override,
 * then the global reserve, then Pi's default). Null when compaction is off or the window is unknown.
 *
 * @param {{ provider?: string, id?: string, contextWindow?: unknown } | null | undefined} model
 * @param {{ compaction?: { enabled?: boolean, reserveTokens?: number, modelOverrides?: Record<string, { reserveTokens?: number }> } } | null | undefined} settings
 * @returns {number | null}
 */
export function runtimePoint(model, settings) {
  const window = model?.contextWindow;
  const c = settings?.compaction;
  if (c?.enabled === false || !isNum(window) || window <= 0) return null;
  const own = c?.modelOverrides?.[`${model.provider}/${model.id}`]?.reserveTokens;
  const reserve = isNum(own) ? own : isNum(c?.reserveTokens) ? c.reserveTokens : PI_DEFAULT_RESERVE;
  return window - reserve;
}
