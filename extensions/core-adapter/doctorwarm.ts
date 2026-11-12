// `/foreman doctor warm` (docs/cache.md): proves the idle warm live on the current provider. One small fresh request with a
// unique marker in a prefix large enough to be cached, then one warm of the same messages through the idle warm's own
// replay (`replayWarm`, warmreplay.ts); hit when the warm read the prefix back. Never runs unasked: it states its cost, asks, and
// sends nothing on a refusal, a decline or without a UI. Runs once per call. The conversation, the captured warm request,
// the warm budget and the footer are not touched: the messages are the probe's own. The provider call (`api`) is injected.
import { randomUUID } from "node:crypto";
import type { CachePolicy } from "./cachepolicy.ts";
import { costAt } from "./cost.ts";
import { cleanError, type WarmReply } from "./selfwarm.ts";
import { warmHit, type Rates } from "./warmbudget.ts";
import { replayWarm, type ReplayApi } from "./warmreplay.ts";

/**
 * Rough size of the probe prefix in tokens (about 7 tokens per filler line, 700 lines). Assumption, not a measured count: the
 * smallest cacheable prefix is 1024 tokens on most providers and up to 4096 on some models, so the prefix sits above that. A provider
 * with a larger minimum reports no cache write for the fresh request, and the result says so.
 */
export const PROBE_PREFIX_TOKENS = 5000;
const FILLER_LINES = 700;
const TIMEOUT_MS = 120_000;

export interface DoctorWarmDeps {
  /** The current model (`ctx.model`), passed to the provider call as it is. */
  model(): { provider: string; id: string } | null;
  policy(): CachePolicy | null;
  /** A turn is in flight (`!ctx.isIdle()`). */
  busy(): boolean;
  hasUI: boolean;
  confirm(title: string, message: string): Promise<boolean>;
  /** Rates of the current model; null = no price known. */
  rates(promptTokens: number): Rates | null;
  /** The replay API of the idle warm with the provider call (`liveReplayApi` in warmwire.ts). */
  api(): Promise<ReplayApi>;
  /** The replay of the idle warm; injected only so a test can see that both requests go through it. */
  replay?: typeof replayWarm;
  trace(r: Record<string, unknown>): void;
}

export interface DoctorWarmResult {
  text: string;
  level: "info" | "warning" | "error";
  /** Requests sent: 0 on a refusal, a decline or no UI; 2 on a run unless the fresh request failed. */
  sent: number;
}

const SKIP_FIX: Record<string, (p: string) => string> = {
  no_entry: (p) => `set providers.${p}.cache.ttlSeconds and providers.${p}.cache.keepalive.enabled: true`,
  ttl_unknown: (p) => `set providers.${p}.cache.ttlSeconds`,
  ttl_long: () => "a TTL of 3600 s or more needs no keep-alive, so there is no warm to prove",
  disabled: (p) => `set providers.${p}.cache.keepalive.enabled: true`,
  ttl_too_short: (p) => `set providers.${p}.cache.ttlSeconds above 10`,
};

let active = false;

const usd = (n: number | null): string => (n === null ? "cost unknown" : `$${n.toFixed(4)}`);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Messages of the probe: one user message, a unique marker first so no existing cache entry can match, then the filler. */
function probeMessages(marker: string): unknown[] {
  const lines = Array.from({ length: FILLER_LINES }, (_, i) => `Line ${i + 1}: filler for the pi-foreman cache probe, ignore it.`);
  const text = `pi-foreman cache probe ${marker}. Reply with the word ok.\n${lines.join("\n")}\nReply with the word ok.`;
  return [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }];
}

function estimate(rates: Rates | null): number | null {
  if (!rates) return null;
  const n = PROBE_PREFIX_TOKENS;
  const fresh = costAt({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, rates).total + (n * Math.max(rates.cacheWrite, rates.input)) / 1e6;
  return fresh + costAt({ cacheRead: n, output: 1, input: 0, cacheWrite: 0 }, rates).total;
}

/** The cost of a reply: the provider's own figure, else priced from the rates; null when neither is known. */
function costOf(reply: WarmReply, rates: Rates | null): number | null {
  const own = num(reply.usage.cost?.total);
  if (own > 0) return own;
  if (!rates) return null;
  const u = reply.usage;
  return costAt({ input: num(u.input), output: num(u.output), cacheRead: num(u.cacheRead), cacheWrite: num(u.cacheWrite) }, rates).total;
}

export async function doctorWarm(d: DoctorWarmDeps): Promise<DoctorWarmResult> {
  const refuse = (reason: string, why: string): DoctorWarmResult => {
    d.trace({ event: "doctor_warm", outcome: "refused", reason });
    return { text: `doctor warm: refused (${reason}): ${why}. No request was sent.`, level: "warning", sent: 0 };
  };
  const model = d.model();
  if (!model) return refuse("no_model", "no model is selected");
  const policy = d.policy();
  if (!policy || !policy.keepaliveOwned) {
    const skip = policy?.skip ?? (policy && policy.ttlSeconds !== null ? "ttl_too_short" : "no_entry");
    const fix = (SKIP_FIX[skip] ?? SKIP_FIX.no_entry)(model.provider);
    return refuse(skip, `the idle keep-alive is off for ${model.provider}/${model.id}; fix: ${fix}`);
  }
  if (d.busy()) return refuse("busy", "a turn is in flight and the probe must not interleave with it; run it when the session is idle");
  if (active) return refuse("busy", "a doctor warm probe is already running");

  const rates = d.rates(PROBE_PREFIX_TOKENS);
  const est = estimate(rates);
  const cost = est === null ? "cost unknown for this model" : `estimated cost about ${usd(est)} (one cache write plus one cache read of ~${PROBE_PREFIX_TOKENS} tokens)`;
  const ask = `Prove the idle warm on ${model.provider}/${model.id}: send one small fresh request (a ~${PROBE_PREFIX_TOKENS}-token prefix with a unique marker) and, once it completes, one warm of it through the idle warm's replay. Two real provider requests, ${cost}. The conversation and the session's own warm are not touched. It runs once. Send them?`;
  if (!d.hasUI) {
    d.trace({ event: "doctor_warm", outcome: "declined", reason: "no_ui" });
    return { text: `doctor warm: needs a UI to ask for confirmation, so nothing was sent. ${ask}`, level: "warning", sent: 0 };
  }
  const yes = await d.confirm("pi-foreman doctor warm", ask).catch(() => false);
  if (!yes) {
    d.trace({ event: "doctor_warm", outcome: "declined", reason: "declined" });
    return { text: "doctor warm: declined, nothing was sent.", level: "info", sent: 0 };
  }

  active = true;
  try {
    const replay = d.replay ?? replayWarm;
    const messages = probeMessages(randomUUID());
    let failure = null as string | null;
    const base = await d.api();
    const send = async (): Promise<WarmReply | null> => {
      failure = null;
      const signal = AbortSignal.timeout(TIMEOUT_MS);
      return replay(model, messages, signal, { ...base, onError: (m) => (failure = cleanError(m)) }).catch((e) => ((failure = cleanError(e instanceof Error ? e.message : e)), null));
    };
    const fail = (which: string, sent: number): DoctorWarmResult => {
      const reason = failure ?? "no reply (aborted or timed out)";
      d.trace({ event: "doctor_warm", outcome: "error", reason: which, message: reason });
      return { text: `doctor warm: ERROR on the ${which} request (${model.provider}/${model.id}): ${reason}.${sent === 1 ? " The warm was not sent." : ""}`, level: "error", sent };
    };

    const fresh = await send();
    if (!fresh) return fail("fresh", 1);
    if (d.busy()) {
      d.trace({ event: "doctor_warm", outcome: "refused", reason: "busy" });
      return { text: "doctor warm: a turn started after the fresh request, so the warm was not sent (the probe does not interleave with a turn).", level: "warning", sent: 1 };
    }
    const warm = await send();
    if (!warm) return fail("warm", 2);

    const f = fresh.usage;
    const w = warm.usage;
    const written = num(f.cacheWrite);
    const hit = warmHit({ cacheRead: num(w.cacheRead), cacheWrite: num(w.cacheWrite) }) && num(w.cacheRead) >= written;
    const fc = costOf(fresh, rates);
    const wc = costOf(warm, rates);
    const total = fc === null || wc === null ? null : fc + wc;
    const head = `doctor warm: ${hit ? "HIT" : "MISS"} on ${model.provider}/${model.id}`;
    const lines = [
      head,
      `  fresh: cacheRead ${num(f.cacheRead)}, cacheWrite ${written}, cost ${usd(fc)}`,
      `  warm:  cacheRead ${num(w.cacheRead)}, cacheWrite ${num(w.cacheWrite)}, cost ${usd(wc)}`,
      `  total cost ${usd(total)}`,
    ];
    let reason: string | undefined;
    if (hit) lines.push("  The idle warm reads the cache on this provider.");
    else {
      reason = "self_warm_miss";
      lines.push(`  reason: ${reason} (keepalive window_end, as the idle warm traces it): the warm did not read the cache (cacheRead ${num(w.cacheRead)} of ${written} written).`);
      if (written === 0) lines.push("  The fresh request wrote nothing to the cache: the prefix may be below this model's minimum cacheable size, or the provider does not cache it.");
      lines.push("  Check the TTL and promptCache in docs/cache.md.");
    }
    d.trace({ event: "doctor_warm", outcome: hit ? "hit" : "miss", ...(reason ? { reason } : {}), model: `${model.provider}/${model.id}`, cacheRead: num(w.cacheRead), cacheWrite: num(w.cacheWrite), ...(total !== null ? { cost: total } : {}) });
    return { text: lines.join("\n"), level: hit ? "info" : "warning", sent: 2 };
  } finally {
    active = false;
  }
}
