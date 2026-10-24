// Wiring of the warm owner (selfwarm.ts) and the presence gate (presence.ts) to the Pi session: config, price table,
// registry, the usage log and the Pi pieces the replay needs. Kept out of index.ts so that file only constructs and forwards.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { get } from "./config.ts";
import { resolveWarmPolicy } from "./cachepolicy.ts";
import { loadPrices } from "./cost.ts";
import { lookupRate } from "./footer.ts";
import type { Busy } from "./idlecache.ts";
import { keepaliveLine } from "./keepalive.ts";
import { Presence } from "./presence.ts";
import { SelfWarm } from "./selfwarm.ts";
import { appendUsage, pricedLine, type LineContext } from "./usage.ts";
import { warmRates } from "./warmbudget.ts";
import { replayWarm, replayable } from "./warmreplay.ts";

export interface WarmWireOpts {
  pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "getThinkingLevel" | "getSettings">;
  pkgRoot: string;
  isChild: boolean;
  /** The latest event context of the foreman session. */
  ctx(): ExtensionContext | null;
  /** The merged config object. */
  config(): unknown;
  usage(): { file: string; line: LineContext };
  trace(r: Record<string, unknown>): void;
  busy(): Busy;
  /** Pi's `cacheWarming` setting is "idle". */
  piIdleMode(): boolean;
  /** Idle-floor gate + ctx.compact (idleCompact in index.ts). */
  compact(): { tier: string; model: string | null } | null;
  /** Context tokens of the foreman session (compactMinTokens gate). */
  contextTokens?(): number | null;
}

export function createWarm(o: WarmWireOpts): { presence: Presence; selfWarm: SelfWarm } {
  const policy = () => {
    const m = o.ctx()?.model;
    return m ? resolveWarmPolicy(o.config(), m.provider, m.id) : null;
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
    busy: () => o.busy(),
    piIdleMode: () => o.piIdleMode(),
    compact: () => o.compact(),
    contextTokens: o.contextTokens,
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
