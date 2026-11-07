// Wiring of the warm owner (selfwarm.ts) and the presence gate (presence.ts) to the Pi session: config, price table,
// registry, the usage log and the Pi pieces the replay needs. Kept out of index.ts so that file only constructs and forwards.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { get } from "./config.ts";
import { resolveWarmPolicy } from "./cachepolicy.ts";
import { loadPrices } from "./cost.ts";
import { lookupRate } from "./footer.ts";
import { keepaliveLine } from "./keepalive.ts";
import { Presence } from "./presence.ts";
import { SelfWarm, type WarmSignals } from "./selfwarm.ts";
import { appendUsage, pricedLine, type LineContext } from "./usage.ts";
import { warmRates } from "./warmbudget.ts";
import { replayWarm, replayable } from "./warmreplay.ts";

export interface WarmWireOpts {
  pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "getThinkingLevel" | "getSettings">;
  pkgRoot: string;
  isChild: boolean;
  /** Derived claude-bridge TTL in seconds (bridgettl.ts); absent or null = none. */
  bridgeTtl?(): number | null;
  /** The latest event context of the foreman session. */
  ctx(): ExtensionContext | null;
  /** The merged config object. */
  config(): unknown;
  usage(): { file: string; line: LineContext };
  trace(r: Record<string, unknown>): void;
  /** What the session is doing now (tier decision). */
  signals(): WarmSignals;
  /** A message is queued. */
  queued(): boolean;
  /** Final-warm gate + ctx.compact (idleCompact in index.ts). */
  compact(): { point: number | null; model: string | null } | null;
  /** Context tokens of the session (final-warm gate, compactMinTokens). */
  contextTokens?(): number | null;
  /** Context window of the session's model (final-warm gate). */
  contextWindow?(): number | null;
  /** A claude-bridge config approval is pending (the replay is skipped). */
  driftPending?(): boolean;
  /** The footer's keep-alive glyph. */
  setGlyph?(on: boolean): void;
}

/** `providers.claude-bridge.cache.keepalive.children: true`: children through the bridge warm. */
export function bridgeChildrenOn(config: unknown): boolean {
  const v = get(config, "providers.claude-bridge.cache.keepalive.children");
  return v === true;
}

export function createWarm(o: WarmWireOpts): { presence: Presence; selfWarm: SelfWarm } {
  const policy = () => {
    const m = o.ctx()?.model;
    if (!m) return null;
    const p = resolveWarmPolicy(o.config(), m.provider, m.id, o.bridgeTtl?.() ?? null);
    return o.isChild && m.provider === "claude-bridge" && p.keepaliveOwned && !bridgeChildrenOn(o.config()) ? { ...p, keepaliveOwned: false, bridgeChildOff: true } : p;
  };
  const presence = new Presence({
    now: () => Date.now(),
    trace: (r) => o.trace(r),
    config: () => {
      const cfg = o.config();
      const after = get(cfg, "presence.awayAfterMinutes");
      const cmd = get(cfg, "presence.command");
      return {
        enabled: get(cfg, "presence.enabled") !== false,
        awayAfterMinutes: typeof after === "number" && after >= 1 ? after : 11,
        command: typeof cmd === "string" && cmd.trim() ? cmd : null,
      };
    },
  });
  const selfWarm = new SelfWarm({
    now: () => Date.now(),
    isChild: o.isChild,
    policy,
    presence,
    signals: () => o.signals(),
    queued: () => o.queued(),
    compact: () => o.compact(),
    contextTokens: o.contextTokens,
    contextWindow: o.contextWindow,
    driftPending: o.driftPending,
    sessionKey: () => {
      const sm = o.ctx()?.sessionManager as { getSessionFile?(): string | undefined; getSessionId?(): string } | undefined;
      return sm?.getSessionFile?.() || sm?.getSessionId?.() || "process";
    },
    setGlyph: o.setGlyph,
    trace: (r) => o.trace(r),
    rates: (promptTokens) => {
      const ctx = o.ctx();
      const m = ctx?.model;
      if (!ctx || !m) return null;
      return warmRates({ table: loadPrices(o.pkgRoot), registry: lookupRate(ctx.modelRegistry as never, m.provider, m.id), model: m.id, promptTokens, ttlSeconds: policy()?.ttlSeconds ?? null });
    },
    replayable: () => replayable(o.ctx()?.model as never, o.pi.getThinkingLevel()),
    replay: async (messages, signal) => {
      const ctx = o.ctx();
      if (!ctx?.model) return null;
      const { convertToLlm } = await import("@earendil-works/pi-coding-agent");
      const active = new Set(o.pi.getActiveTools());
      return replayWarm(ctx.model, messages, signal, {
        convertToLlm: (m) => convertToLlm(m as never) as unknown[],
        tools: () => o.pi.getAllTools().filter((t) => active.has(t.name)).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
        thinkingLevel: () => o.pi.getThinkingLevel(),
        sessionId: () => ctx.sessionManager.getSessionId(),
        cacheRetention: () => (process.env.PI_CACHE_RETENTION === "long" ? "long" : "short"),
        streamSimple: (model, context, options) => (ctx.modelRegistry as never as { streamSimple(m: unknown, c: unknown, op: unknown): { result(): Promise<unknown> } }).streamSimple(model, context, options),
      });
    },
    record: (reply) => {
      const ctx = o.ctx();
      const u = o.usage();
      const entry = { provider: reply.provider, model: reply.model, usage: reply.usage, timestamp: new Date(reply.timestamp).toISOString() };
      const base = keepaliveLine(u.line, entry, ctx?.modelRegistry as never);
      const line = pricedLine({ ...base, source: "foreman" }, loadPrices(o.pkgRoot), lookupRate(ctx?.modelRegistry as never, base.provider, base.model));
      return appendUsage(u.file, line) ? line : null;
    },
  });
  return { presence, selfWarm };
}
