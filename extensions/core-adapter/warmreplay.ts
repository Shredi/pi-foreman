// Replay of the last real request for the self-warm (selfwarm.ts): the messages captured at `context_with_system`
// (system message first) become Pi's Context again, and the call is sent with maxTokens 1. Nothing is sent that the
// last real request did not send: same system prompt, messages, tools, session id and cache retention. The Pi side
// (converter, tools, model registry) is injected so the module is testable without the Pi package.
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

/** The leading system message as the system prompt and the rest. */
export function splitSystem(messages: unknown[]): { systemPrompt: string; rest: unknown[] } {
  const first = messages[0];
  if (isObj(first) && first.role === "system") return { systemPrompt: textOf(first.content), rest: messages.slice(1) };
  return { systemPrompt: "", rest: messages };
}

export interface ReplayApi {
  /** Pi's convertToLlm. */
  convertToLlm(messages: unknown[]): unknown[];
  /** The declared tools in Pi's order (pi.getAllTools() filtered by pi.getActiveTools()), as name, description, parameters. */
  tools(): unknown[];
  thinkingLevel(): string | undefined;
  sessionId(): string;
  cacheRetention(): unknown;
  /** ctx.modelRegistry.streamSimple */
  streamSimple(model: unknown, context: unknown, options: unknown): { result(): Promise<unknown> };
}

export async function replayWarm(model: unknown, messages: unknown[], signal: AbortSignal, api: ReplayApi): Promise<WarmReply | null> {
  const { systemPrompt, rest } = splitSystem(messages);
  const context = { systemPrompt, messages: api.convertToLlm(rest), tools: api.tools() };
  const cacheRetention = api.cacheRetention();
  const options: Json = { sessionId: api.sessionId(), maxTokens: 1, maxRetries: 0, signal };
  const reasoning = reasoningOf(api.thinkingLevel());
  if (reasoning) options.reasoning = reasoning;
  if (cacheRetention !== undefined) options.cacheRetention = cacheRetention;
  const msg = await api.streamSimple(model, context, options).result();
  if (signal.aborted || !isObj(msg) || msg.stopReason === "aborted" || msg.stopReason === "error" || !isObj(msg.usage)) return null;
  return {
    provider: typeof msg.provider === "string" ? msg.provider : null,
    model: typeof msg.responseModel === "string" ? msg.responseModel : typeof msg.model === "string" ? msg.model : null,
    usage: msg.usage as WarmReply["usage"],
    timestamp: Date.now(),
  };
}
