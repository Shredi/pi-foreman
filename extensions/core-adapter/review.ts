// Review model helpers of the gate (gatereview.ts): which model reviews for the active provider, the
// reviewer's error classification, the usage estimate for a bridge call, and the user-prompt read of a
// before_agent_start event.
import type { Json } from "./config.ts";
import { get } from "./config.ts";
import { isSubagentWakeText } from "./idlecustom.ts";

export const DEFAULT_REVIEW_TIMEOUT_MS = 15_000;

/**
 * Why a review call failed, short enough for the log and the trace: `auth`, `aborted`, or
 * `provider_error:<first 60 chars of the provider's message>` (`no_model` and `internal` are set
 * by the caller). The reviewed value is cut out of the message first, so a provider that echoes
 * its input cannot put the command into the log.
 */
export function errorKind(message: unknown, value = ""): string {
  let m = String(message ?? "").replace(/\s+/g, " ").trim();
  for (const v of [value, value.trim(), value.replace(/\s+/g, " ").trim()]) if (v.length >= 4) m = m.split(v).join("<value>");
  if (/not logged in|unauthori[sz]ed|\b40[13]\b|api key|credential|authenticat|not configured/i.test(m)) return "auth";
  if (/^abort/i.test(m)) return "aborted";
  return `provider_error:${m.slice(0, 60) || "unknown"}`;
}

export interface ReviewTarget {
  provider: string;
  modelId: string;
  timeoutMs: number;
  /** Picked by autoReviewTarget (no review.model set). */
  auto?: boolean;
}

/** `providers.<provider>.review` of the merged config, or null (review off for that provider). */
export function reviewTarget(config: Json | undefined, provider: string | undefined): ReviewTarget | null {
  if (!provider) return null;
  const model = get(config, `providers.${provider}.review.model`);
  if (typeof model !== "string" || !model.trim()) return null;
  const t = get(config, `providers.${provider}.review.timeoutMs`);
  const slash = model.indexOf("/");
  return {
    provider: slash > 0 ? model.slice(0, slash) : provider,
    modelId: slash > 0 ? model.slice(slash + 1) : model,
    timeoutMs: typeof t === "number" && Number.isFinite(t) && t > 0 ? t : DEFAULT_REVIEW_TIMEOUT_MS,
  };
}

/**
 * D3: with no `providers.<provider>.review.model`, the cheapest model by registry `cost.input`
 * among the provider's role-map models (`model` and `strong` of every role, foreman included)
 * that the registry finds and has auth for; null when none (every ask goes to the human).
 */
export function autoReviewTarget(config: Json | undefined, provider: string | undefined, registry: RegistryLike | undefined): ReviewTarget | null {
  if (!provider || !registry) return null;
  const roles = get(config, `providers.${provider}.roles`);
  if (!roles || typeof roles !== "object") return null;
  const ids = new Set<string>();
  for (const r of Object.values(roles as Record<string, unknown>)) {
    if (!r || typeof r !== "object") continue;
    const e = r as { model?: unknown; strong?: { model?: unknown } };
    for (const m of [e.model, e.strong?.model]) if (typeof m === "string" && m.trim()) ids.add(m.trim().replace(/:(off|minimal|low|medium|high|xhigh|max)$/, ""));
  }
  let best: { provider: string; modelId: string; cost: number } | null = null;
  for (const id of ids) {
    const slash = id.indexOf("/");
    const p = slash > 0 ? id.slice(0, slash) : provider;
    const modelId = slash > 0 ? id.slice(slash + 1) : id;
    let model: unknown;
    try {
      model = registry.find(p, modelId);
      if (!model || (registry.hasConfiguredAuth && !registry.hasConfiguredAuth(model as never))) continue;
    } catch {
      continue;
    }
    const raw = (model as { cost?: { input?: unknown } }).cost?.input;
    const cost = typeof raw === "number" && Number.isFinite(raw) ? raw : Infinity;
    if (!best || cost < best.cost) best = { provider: p, modelId, cost };
  }
  if (!best) return null;
  const t = get(config, `providers.${provider}.review.timeoutMs`);
  return { provider: best.provider, modelId: best.modelId, timeoutMs: typeof t === "number" && Number.isFinite(t) && t > 0 ? t : DEFAULT_REVIEW_TIMEOUT_MS, auto: true };
}

/** The slice of Pi's ModelRegistry the review uses. */
export interface RegistryLike {
  find(provider: string, modelId: string): unknown;
  /** Pi's ModelRegistry has it; a registry without it counts every found model as usable. */
  hasConfiguredAuth?(model: never): boolean;
  complete(model: never, context: never, options?: never): Promise<{ content?: unknown; stopReason?: string; errorMessage?: string }>;
}

function replyText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : "")).join("");
}

/**
 * The bridge reports zero usage for `cacheRetention: "none"` calls. When every token field is 0, return
 * the reply with a chars/4 estimate of what was sent and received and `estimated: true`.
 */
export function withEstimatedUsage<T extends object>(reply: T, promptText: string, system: string): T {
  const u = (reply as { usage?: Record<string, unknown> }).usage;
  const tok = (k: string): number => (typeof u?.[k] === "number" ? (u[k] as number) : 0);
  if (["input", "output", "cacheRead", "cacheWrite"].some((k) => tok(k) > 0)) return reply;
  const out = replyText((reply as { content?: unknown }).content);
  return { ...reply, usage: { ...u, input: Math.ceil((system.length + promptText.length) / 4), output: Math.ceil(out.length / 4) }, estimated: true };
}

/**
 * The user prompt of a `before_agent_start` event, or null when a custom message starts the run.
 * Pi 1.2 also fires the event for `pi.sendMessage(..., { triggerTurn: true })` idle runs (a wake,
 * a child notice) with `messageType: "custom"` and no `prompt`; such a run must not replace the
 * user's request. Pi 1.1 has no `messageType` and fires only for user runs, so a missing one is a
 * user run.
 */
export function userPromptOf(event: unknown): string | null {
  const e = (event && typeof event === "object" ? event : {}) as { messageType?: unknown; prompt?: unknown };
  if (e.messageType !== undefined && e.messageType !== "user") return null;
  // pi-subagents 0.76.1+ wakes an idle parent with a user message of its own (idlecustom.ts): not the owner's request.
  if (isSubagentWakeText(e.prompt)) return null;
  return typeof e.prompt === "string" ? e.prompt : "";
}
