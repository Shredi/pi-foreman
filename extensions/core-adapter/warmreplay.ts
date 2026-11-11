// Replay of the last real request for the self-warm (selfwarm.ts): the messages captured at `context_with_system`
// (leading system message with its sections included) become the provider context again, converted by Pi's
// convertToLlm, with no separate system prompt and no tools, as the agent loop's own context has neither: the provider
// derives the system text from the messages as it does for a real turn. Declarations of tools that Pi hides from the
// request (`hidden`) are projected out of the system messages the way Pi's projection does. The call is sent with
// maxTokens 1, the session id, the thinking level and the cache retention. Not made equal to a real turn: the Pi
// `identity` and `transformHeaders` options, the retention source (PI_CACHE_RETENTION), tools hidden by other
// extensions, Pi's block-images filter (a real turn converts with `convertToLlmWithBlockImages`, the replay with plain
// `convertToLlm`, so the requests differ when images are blocked and the context holds images) and the
// `before_provider_request` payload hook (it rewrites the real request, not the warm). Each of these is a known cause
// of a missed warm. The Pi side (converter, hidden names, model registry) is injected so the module is testable without the Pi package.
import type { WarmReply } from "./selfwarm.ts";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** Pi's isReplayable rule (cache-warmer.js): a budget-thinking anthropic-messages model cannot be replayed with reasoning. */
export function replayable(model: { api?: unknown; compat?: { forceAdaptiveThinking?: unknown } } | null | undefined, thinkingLevel: string | undefined): boolean {
  if (!model) return false;
  const reasoning = reasoningOf(thinkingLevel);
  if (!reasoning || model.api !== "anthropic-messages") return true;
  return model.compat?.forceAdaptiveThinking === true;
}

/** The agent loop sends no `reasoning` option for thinking level "off". */
export const reasoningOf = (level: string | undefined): string | undefined => (level && level !== "off" ? level : undefined);

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (isObj(b) && typeof b.text === "string" ? b.text : "")).join("");
};

/** The leading system message as the system prompt and the rest. Not used by the replay (it keeps the head in the messages). */
export function splitSystem(messages: unknown[]): { systemPrompt: string; rest: unknown[] } {
  const first = messages[0];
  if (isObj(first) && first.role === "system") return { systemPrompt: textOf(first.content), rest: messages.slice(1) };
  return { systemPrompt: "", rest: messages };
}

export interface ReplayApi {
  /** Pi's convertToLlm. */
  convertToLlm(messages: unknown[]): unknown[];
  /** Names of the tools whose declarations Pi hides from the request. */
  hidden?(): readonly string[];
  thinkingLevel(): string | undefined;
  sessionId(): string;
  cacheRetention(): unknown;
  /** ctx.modelRegistry.streamSimple */
  streamSimple(model: unknown, context: unknown, options: unknown): { result(): Promise<unknown> };
  /** The provider's error text of an errored call (raw; the owner cleans and caps it). */
  onError?(message: string): void;
}

/** Pi's hidden-declarations projection: hidden names leave `toolsAdded` and `toolsRemoved` of the system messages. New objects; the input is not mutated. */
export function withoutHidden(messages: unknown[], hidden: readonly string[]): unknown[] {
  if (hidden.length === 0) return messages;
  const skip = new Set(hidden);
  const keep = (list: unknown): unknown[] => (Array.isArray(list) ? list.filter((t) => !(isObj(t) && typeof t.name === "string" && skip.has(t.name))) : []);
  return messages.map((m) => {
    if (!isObj(m) || m.role !== "system" || (!m.toolsAdded && !m.toolsRemoved)) return m;
    const { toolsAdded, toolsRemoved, ...rest } = m;
    const added = keep(toolsAdded);
    const removed = keep(toolsRemoved);
    return { ...rest, ...(added.length > 0 ? { toolsAdded: added } : {}), ...(removed.length > 0 ? { toolsRemoved: removed } : {}) };
  });
}

export async function replayWarm(model: unknown, messages: unknown[], signal: AbortSignal, api: ReplayApi): Promise<WarmReply | null> {
  const context = { messages: api.convertToLlm(withoutHidden(messages, api.hidden?.() ?? [])) };
  const cacheRetention = api.cacheRetention();
  const options: Json = { sessionId: api.sessionId(), maxTokens: 1, maxRetries: 0, signal };
  const reasoning = reasoningOf(api.thinkingLevel());
  if (reasoning) options.reasoning = reasoning;
  if (cacheRetention !== undefined) options.cacheRetention = cacheRetention;
  const msg = await api.streamSimple(model, context, options).result();
  if (isObj(msg) && msg.stopReason === "error" && !signal.aborted && typeof msg.errorMessage === "string") api.onError?.(msg.errorMessage);
  if (signal.aborted || !isObj(msg) || msg.stopReason === "aborted" || msg.stopReason === "error" || !isObj(msg.usage)) return null;
  return {
    provider: typeof msg.provider === "string" ? msg.provider : null,
    model: typeof msg.responseModel === "string" ? msg.responseModel : typeof msg.model === "string" ? msg.model : null,
    usage: msg.usage as WarmReply["usage"],
    timestamp: Date.now(),
  };
}
