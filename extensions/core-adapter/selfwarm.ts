// Warm owner of every session (docs/cache.md): the only sender of idle prompt-cache warms (Pi's own warmer is always told
// `stop`). An idle stretch starts at each real request end and has no fixed length: a warm goes out at
// min(0.9 x TTL, TTL - 10 s) after the last cache touch (a real request end or a completed warm) as long as the cost rule
// allows it. The spend is capped by a tier: the quarter tier (half of `budgetShare`) always, the half tier (`budgetShare`) while a
// strong reason holds (activity rule). The warm replays the context captured at `context_with_system` with maxTokens 1, never
// while a real request is in flight or a message is queued. When the next warm is refused and the context is large, the last warm
// is followed by a warm compaction.
import { overFinalGate } from "./compaction.ts";
import type { CachePolicy } from "./cachepolicy.ts";
import type { Presence } from "./presence.ts";
import type { Timers } from "./prwatch.ts";
import type { UsageLine } from "./usage.ts";
import { WarmBudget, warmHit, type BudgetCheck, type Rates } from "./warmbudget.ts";
import { warmCompact } from "./warmcompact.ts";

/** A warm is sent this share of the TTL after the last touch, but never later than `WARM_MARGIN_S` before the TTL ends. */
export const WARM_TICK_SHARE = 0.9;
export const WARM_MARGIN_S = 10;

/** Ms after the last touch at which a warm is sent: min(0.9 x TTL, TTL - 10 s); null for a TTL of 10 s or less (no warm). */
export function warmDelayMs(ttlSeconds: number | null): number | null {
  if (ttlSeconds === null || ttlSeconds <= WARM_MARGIN_S) return null;
  return Math.min(WARM_TICK_SHARE * ttlSeconds, ttlSeconds - WARM_MARGIN_S) * 1000;
}

/** An owner who is away for less than this (on top of the presence debounce) still counts as present for the tier. */
export const AWAY_GRACE_MS = 15 * 60_000;

/** Zero allowed warms are acted on this long after settle (the shorter of 60 s and a quarter of the TTL), so an owner who answers at once is never compacted. */
export const settleGraceMs = (ttlSeconds: number | null): number => Math.min(60_000, 0.25 * (ttlSeconds ?? 0) * 1000);

/** A queued message that has not become a request yet: the warm is tried again after this long. */
const QUEUED_RETRY_MS = 5000;

export type Tier = "half" | "quarter";
export type OwnerPresence = "present" | "away" | "grace" | "unknown";
export type StrongReason = "subagent" | "bg_task" | "wait";
export type TierReason = StrongReason | "question" | "dialog" | "command" | "turn" | "idle";

/** What the session is doing right now, read at each tier decision. */
export interface WarmSignals {
  /** Strong whatever the presence: a subagent (sync or async), a background task (foreman_bg, bg_run) or a foreman_wait. */
  strongA: StrongReason | null;
  /** The session's turn is running. */
  turn: boolean;
  /** An ask_user_question or plan_mode_question call is open. */
  question: boolean;
  /** A permission or approval dialog is waiting. */
  dialog: boolean;
  /** The session waits on a command it called directly (bash, powershell). */
  command: boolean;
}

export interface TierView {
  tier: Tier;
  reason: TierReason;
  presence: OwnerPresence;
}

export interface WarmReply {
  provider: string | null;
  model: string | null;
  usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
  timestamp: number;
}

export interface SelfWarmDeps {
  now(): number;
  timers?: Timers;
  isChild: boolean;
  policy(): CachePolicy | null;
  presence: Presence;
  signals(): WarmSignals;
  /** A message is queued: no warm goes out. */
  queued(): boolean;
  /** Rates for the current model and a prompt size; null = budget unavailable. */
  rates(promptTokens: number): Rates | null;
  /** The compaction gate behind ctx.compact (final-warm gate, latch); null = declined. */
  compact(): { point: number | null; model: string | null } | null;
  /** Context tokens for the final-warm gate and compactMinTokens; absent or null = unknown. */
  contextTokens?(): number | null;
  /** The context window of the current model (final-warm gate); absent or null = unknown. */
  contextWindow?(): number | null;
  /** A claude-bridge config approval is pending: the replay would start Claude Code on unapproved config. */
  driftPending?(): boolean;
  /** Key of the session this instance serves (session file or id); instances of one process with the same key share one owner claim, the miss flag and the budget. Absent or null = private state. */
  sessionKey?(): string | null;
  trace(r: Record<string, unknown>): void;
  /** The footer's keep-alive glyph. */
  setGlyph?(on: boolean): void;
  /** Pi's isReplayable rule for the current model and thinking level. */
  replayable(): boolean;
  /** Send the replay with maxTokens 1; null when it errored or was aborted. */
  replay(messages: unknown[], signal: AbortSignal, onError?: (message: string) => void): Promise<WarmReply | null>;
  /** Append the usage line (kind keepalive, source foreman); null when it could not be written. */
  record(reply: WarmReply): UsageLine | null;
}

const MAX_ERROR = 200;
/** A replay error as one short line for the trace: control characters stripped, capped. The provider's error text only, never prompt content. */
export const cleanError = (m: unknown): string => String(m ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_ERROR);

const realTimers: Timers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** State shared by every SelfWarm instance of one session in this process (the adapter can be loaded twice in a bridge child). */
interface SessionWarm {
  /** How warming ended in the current idle stretch (cleared by the next real request): a miss, or an error of the replay. */
  endedBy: "miss" | "error" | null;
  owner: object | null;
  budget: WarmBudget;
  childOffTraced: boolean;
  notReplayableTraced: boolean;
}
const REGISTRY = Symbol.for("pi-foreman.selfwarm.sessions");
const registry = (): Map<string, SessionWarm> => {
  const g = globalThis as unknown as Record<symbol, Map<string, SessionWarm> | undefined>;
  return (g[REGISTRY] ??= new Map());
};
const freshSession = (): SessionWarm => ({ endedBy: null, owner: null, budget: new WarmBudget(), childOffTraced: false, notReplayableTraced: false });

type St = "off" | "watching" | "ended";
type Refusal = { reason: "budget" | "budget_unavailable"; budget?: { spent: number; cold: number; share: number } };

/** The share of one cold re-cache the warms of a stretch may cost under a tier. */
export const tierShare = (p: CachePolicy | null, tier: Tier): number => (p?.budgetShare ?? 0.5) * (tier === "half" ? 1 : 0.5);

export interface WarmSnapshot {
  state: St;
  touch: number | null;
  /** The real request that opened the stretch (ms); null = none. */
  stretchStartAt: number | null;
  nextWarmAt: number | null;
  /** Budget check under the active tier, with that tier's share; null = not computable (no warm is sent). */
  budget: (BudgetCheck & { share: number }) | null;
  /** The active tier, why and the owner's presence; null without a policy. */
  tier: TierView | null;
  /** Warms still allowed in the active tier (0 without a budget). */
  warmsLeft: number;
  /** Warms a fresh idle stretch would allow in the active tier (spent = 0); derived, 0 without a budget. */
  warmsFresh: number;
  /** How warming ended in the current idle stretch; null = not ended by a miss or an error. */
  endedBy: "miss" | "error" | null;
  /** End of the TTL of the last allowed warm (ms); null without a touch or a tick. */
  spanEndAt: number | null;
  /** Ms between two warms; null for a TTL of 10 s or less. */
  tickMs: number | null;
}

export class SelfWarm {
  private deps: SelfWarmDeps;
  private timers: Timers;
  private timer: unknown = null;
  private graceTimer: unknown = null;
  private warmsSent = 0;
  private st: St = "off";
  private touch: number | null = null;
  private stretchStart: number | null = null;
  private local = freshSession();
  private captured: unknown[] | null = null;
  private pending: unknown[] | null = null;
  private inFlight = false;
  private compacting = false;
  private ac: AbortController | null = null;
  private gen = 0;
  private compactedForIdle = false;
  private tooShortTraced = false;

  constructor(deps: SelfWarmDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? realTimers;
  }

  state(): St {
    return this.st;
  }

  private shared(): SessionWarm {
    let key: string | null = null;
    try {
      key = this.deps.sessionKey?.() ?? null;
    } catch {
      // private state
    }
    if (!key) return this.local;
    const r = registry();
    let s = r.get(key);
    if (!s) r.set(key, (s = freshSession()));
    return s;
  }

  private get budget(): WarmBudget {
    return this.shared().budget;
  }

  /** A miss ended warming in the current idle stretch (every instance of the session honours it; the next real request clears it). */
  missed(): boolean {
    return this.shared().endedBy === "miss";
  }

  /** pi-foreman sends the warms of this cache: keepalive on, token billing, TTL above 10 s, a replayable model, no miss in this idle stretch. */
  owns(): boolean {
    return this.shared().endedBy !== "miss" && !!this.deps.policy()?.keepaliveOwned && this.deps.replayable();
  }

  lastCacheTouch(): number | null {
    return this.touch;
  }

  // ---- tiers -----------------------------------------------------------------------------------------------

  /** The owner's presence now (live state `owner`): present, away past the grace, in grace, or unknown. */
  ownerPresence(): OwnerPresence {
    return this.presenceAt(this.deps.now());
  }

  private presenceAt(t: number): OwnerPresence {
    const pr = this.deps.presence;
    if (this.deps.isChild) return "present";
    if (pr.away()) {
      const since = pr.awaySince();
      return since !== null && t < since + AWAY_GRACE_MS ? "grace" : "away";
    }
    return pr.enabled() && pr.sample()?.outcome !== "present" ? "unknown" : "present";
  }

  /** The tier at time `t` (ms; a later time predicts the grace expiry): the half tier for a strong reason, else the quarter tier. */
  tierAt(t: number): TierView {
    let sig: WarmSignals;
    try {
      sig = this.deps.signals();
    } catch {
      sig = { strongA: null, turn: false, question: false, dialog: false, command: false };
    }
    const presence = this.presenceAt(t);
    if (sig.strongA) return { tier: "half", reason: sig.strongA, presence };
    if (presence !== "away") {
      const b = sig.question ? "question" : sig.dialog ? "dialog" : sig.command ? "command" : sig.turn ? "turn" : null;
      if (b) return { tier: "half", reason: b, presence };
    }
    return { tier: "quarter", reason: "idle", presence };
  }

  private refusalFor(tier: Tier): Refusal | null {
    const p = this.deps.policy();
    const share = tierShare(p, tier);
    const chk = this.budget.check(this.deps.rates(this.budget.promptTokens()), share);
    if (!chk) return { reason: "budget_unavailable" };
    return chk.ok ? null : { reason: "budget", budget: { spent: chk.spent, cold: chk.cold, share } };
  }

  /** Read-only state for the footer's cache bar: no presence probe, no trace. */
  snapshot(): WarmSnapshot {
    const p = this.deps.policy();
    const now = this.deps.now();
    const view = p ? this.tierAt(now) : null;
    const share = view ? tierShare(p, view.tier) : 0;
    const chk = view ? this.budget.check(this.deps.rates(this.budget.promptTokens()), share) : null;
    const budget = chk ? { ...chk, share } : null;
    const watching = this.st === "watching";
    const warmsLeft = watching && budget && budget.next > 0 ? Math.max(0, Math.floor((share * budget.cold - budget.spent) / budget.next + 1e-9)) : 0;
    const warmsFresh = budget && budget.next > 0 ? Math.max(0, Math.floor((share * budget.cold) / budget.next + 1e-9)) : 0;
    const tick = warmDelayMs(p?.ttlSeconds ?? null);
    const ttlMs = (p?.ttlSeconds ?? 0) * 1000;
    return {
      state: this.st,
      touch: this.touch,
      stretchStartAt: this.stretchStart,
      nextWarmAt: watching ? this.dueAt() : null,
      budget,
      tier: view,
      warmsLeft,
      warmsFresh,
      endedBy: this.shared().endedBy,
      spanEndAt: this.touch === null || tick === null ? null : this.touch + warmsLeft * tick + ttlMs,
      tickMs: tick,
    };
  }

  // ---- state fed by the adapter ---------------------------------------------------------------------------

  /** `context_with_system`: the messages of the request about to be sent (system message first; a forced prompt already projected, see forcedProjection). A real request starts: an in-flight warm is aborted. */
  capture(messages: unknown[]): void {
    this.pending = messages;
    this.inFlight = true;
    this.abort();
    this.clearTimer();
  }

  /** A real request ended: the cache was touched, a new idle stretch starts (the capture of this request becomes the replay source). */
  noteRequest(promptTokens: number): void {
    const d = this.deps;
    this.shared().endedBy = null; // a real request opens a new idle stretch: a miss or an error of the last one does not carry over
    this.inFlight = false;
    if (this.pending) {
      this.captured = this.pending;
      this.pending = null;
    }
    this.touch = d.now();
    this.stretchStart = this.touch;
    this.budget.reset(promptTokens);
    this.warmsSent = 0;
    this.compactedForIdle = false;
    this.compacting = false;
    this.abort();
    this.clearTimer();
    this.timers.clear(this.graceTimer);
    this.graceTimer = null;
    const p = d.policy();
    if (!p) return;
    const sh = this.shared();
    if ((p.bridgeChildOff || p.childOff) && !sh.childOffTraced) {
      sh.childOffTraced = true;
      d.trace({ event: "keepalive", outcome: "skipped", reason: p.bridgeChildOff ? "bridge_child_off" : "child_off" });
    }
    if (!this.owns() || !this.claim()) {
      if (p.keepaliveOwned && !sh.notReplayableTraced && sh.owner === null) {
        sh.notReplayableTraced = true;
        d.trace({ event: "keepalive", outcome: "skipped", reason: "not_replayable" });
      } else if (p.active && p.billing === "token" && p.ttlSeconds !== null && warmDelayMs(p.ttlSeconds) === null && !this.tooShortTraced) {
        this.tooShortTraced = true;
        d.trace({ event: "keepalive", outcome: "skipped", reason: "ttl_too_short", ttl: p.ttlSeconds });
      }
      return this.end("not_owned");
    }
    if (this.st !== "watching") {
      this.st = "watching";
      this.glyph(true);
    }
    this.schedule();
  }

  /** Single owner per session: the first instance to ask owns the timers and the warms; the others stay passive until it shuts down. */
  private claim(): boolean {
    const sh = this.shared();
    if (sh.owner === null) sh.owner = this;
    return sh.owner === this;
  }

  /** A real request ended without a usable reply (error, abort) or its turn ended: the cache keeps its last touch, the capture of the last good request stays. */
  requestFailed(): void {
    if (!this.inFlight) return;
    this.inFlight = false;
    this.pending = null;
    this.schedule();
  }

  /** A Pi-sent warm landed in the usage log (Pi's warmer is told `stop`; a stray entry still counts as a touch). */
  noteWarmLine(line: UsageLine): void {
    if (this.shared().owner !== this) return; // the shared budget is noted once, by the owner
    const at = Date.parse(line.ts);
    if (Number.isFinite(at)) this.touch = Math.max(this.touch ?? 0, at);
    this.budget.note(line);
  }

  /** A model change: the provider cache is gone and the budget starts over. */
  onModelChange(): void {
    this.invalidate();
    this.end("model_change");
  }

  /** Compaction or a model change: the provider cache is gone and the budget starts over. */
  invalidate(): void {
    this.abort();
    this.clearTimer();
    this.touch = null;
    this.stretchStart = null;
    this.captured = null;
    this.budget.reset(0);
    this.warmsSent = 0;
    this.compactedForIdle = false;
    this.compacting = false;
  }

  /** A compaction starts (manual, auto or the final warm one): no warm goes out while it runs. */
  onCompactStart(): void {
    this.compacting = true;
    this.abort();
    this.clearTimer();
  }

  /** The compaction was cancelled or failed: the cache is as warm as before, the timer is armed again. */
  onCompactFailed(): void {
    if (!this.compacting) return;
    this.compacting = false;
    this.schedule();
  }

  onCompact(): void {
    this.invalidate();
    this.end("compact");
  }

  onShutdown(): void {
    const sh = this.shared();
    if (sh.owner === this) sh.owner = null;
    this.abort();
    this.end("shutdown");
    this.deps.presence.disarm();
  }

  /** `agent_settled`: when the first warm is already refused, compact after the settle grace instead of waiting for the first tick. */
  start(): void {
    if (this.st !== "watching" || this.deps.isChild) return;
    this.timers.clear(this.graceTimer);
    const gen = this.gen;
    this.graceTimer = this.timers.set(() => void this.settleCheck(gen), settleGraceMs(this.deps.policy()?.ttlSeconds ?? null));
  }

  // ---- internals -------------------------------------------------------------------------------------------

  private dueAt(): number | null {
    const delay = warmDelayMs(this.deps.policy()?.ttlSeconds ?? null);
    return this.touch === null || delay === null ? null : this.touch + delay;
  }

  private clearTimer(): void {
    this.timers.clear(this.timer);
    this.timer = null;
  }

  private glyph(on: boolean): void {
    try {
      this.deps.setGlyph?.(on);
    } catch {
      // cosmetic
    }
  }

  private schedule(): void {
    this.clearTimer();
    const due = this.dueAt();
    if (this.st !== "watching" || due === null || this.inFlight || this.compacting) return;
    if (!this.deps.isChild) this.deps.presence.armBefore(due);
    this.arm(Math.max(0, due - this.deps.now()));
  }

  private arm(ms: number): void {
    const gen = this.gen;
    this.timer = this.timers.set(() => void this.fire(gen), ms);
  }

  private abort(): void {
    this.gen += 1;
    this.ac?.abort();
    this.ac = null;
  }

  private end(reason: string, message?: string): void {
    this.clearTimer();
    this.timers.clear(this.graceTimer);
    this.graceTimer = null;
    this.gen += 1;
    this.deps.presence.disarm();
    if (reason === "not_owned") {
      const sh = this.shared();
      if (sh.owner === this) sh.owner = null; // the owner stopped owning: free the claim for an instance that can warm
    }
    if (this.st !== "watching") return;
    if (reason === "error") this.shared().endedBy = "error";
    this.deps.trace({ event: "keepalive", outcome: "window_end", reason, ...(message ? { message } : {}) });
    this.st = reason === "error" || reason === "shutdown" || reason === "model_change" || reason === "not_owned" ? "off" : "ended";
    this.glyph(false);
  }

  /** No turn, no subagent run, no queued message: the compaction would not compete with work. */
  private finalBusy(): boolean {
    let sig: WarmSignals | null = null;
    try {
      sig = this.deps.signals();
    } catch {
      // unknown: not busy by signals
    }
    return this.deps.queued() || !!sig?.turn || sig?.strongA === "subagent";
  }

  private compactFor(): void {
    const d = this.deps;
    if (this.compactedForIdle || d.isChild) return;
    const fired = warmCompact({
      policy: d.policy(),
      alreadyCompacted: false,
      busy: () => this.finalBusy(),
      now: d.now(),
      lastTouch: this.touch ?? 0,
      contextTokens: d.contextTokens ? () => d.contextTokens!() : undefined,
      aboveFloor: () => overFinalGate({ tokens: d.contextTokens?.() ?? null, contextWindow: d.contextWindow?.() ?? 0 }),
      compact: () => d.compact(),
      trace: (r) => d.trace(r),
      trigger: "final_warm",
      skipOutcome: "skipped",
    });
    if (fired) {
      this.compactedForIdle = true;
      this.compacting = true;
      this.clearTimer();
    }
  }

  private refuse(hit: Refusal, view: TierView, phase: "settle" | "post_warm" | "pre_warm", compact: boolean): void {
    if (hit.budget) this.deps.trace({ event: "budget", ...hit.budget, tier: view.tier });
    this.deps.trace({ event: "keepalive", outcome: "skipped", reason: hit.reason, tier: view.tier, activity: view.reason, presence: view.presence, count: this.warmsSent, phase });
    if (compact && hit.reason === "budget") this.compactFor(); // an uncomputable budget ends the stretch, it never compacts
    this.end(hit.reason);
  }

  /** The next warm is refused: judged on the state after the last touch, under the tier that will hold at its due time. */
  private nextWarmRefused(): { hit: Refusal; view: TierView } | null {
    const due = this.dueAt();
    if (due === null) return null;
    const view = this.tierAt(due);
    const hit = this.refusalFor(view.tier);
    return hit ? { hit, view } : null;
  }

  /** Zero allowed warms: after the grace and a presence probe, compact instead of waiting for the first tick. */
  private async settleCheck(gen: number): Promise<void> {
    this.graceTimer = null;
    try {
      if (gen !== this.gen || this.st !== "watching") return;
      await this.deps.presence.refresh();
      if (gen !== this.gen || this.st !== "watching") return;
      if (this.ac !== null || this.warmsSent > 0 || this.inFlight) return; // a warm is in flight or sent: the post-warm check decides
      const r = this.nextWarmRefused();
      if (r) this.refuse(r.hit, r.view, "settle", true);
    } catch {
      this.end("error");
    }
  }

  private async fire(gen: number): Promise<void> {
    this.timer = null;
    try {
      if (gen !== this.gen || this.st !== "watching") return;
      const d = this.deps;
      const p = d.policy();
      if (!p || !this.owns() || this.shared().owner !== this) return this.end("not_owned");
      if (this.inFlight || this.compacting) return; // the request end or the compaction end reschedules
      if (d.queued()) return this.arm(QUEUED_RETRY_MS);
      const due = this.dueAt();
      const tickMs = warmDelayMs(p.ttlSeconds);
      if (due === null || tickMs === null) return this.end("error");
      const ttlMs = (p.ttlSeconds ?? 0) * 1000;
      if (d.now() > due + (ttlMs - tickMs) / 2) {
        d.trace({ event: "keepalive", outcome: "skipped", reason: "late" });
        return this.end("late");
      }
      if (!this.captured || !d.replayable()) {
        d.trace({ event: "keepalive", outcome: "skipped", reason: "not_replayable" });
        return this.end("not_replayable");
      }
      if (d.driftPending?.()) {
        d.trace({ event: "keepalive", outcome: "skipped", reason: "claude_cfg_pending" });
        return this.end("claude_cfg_pending");
      }
      if (!d.isChild) await d.presence.refresh();
      if (gen !== this.gen || this.st !== "watching" || this.inFlight || this.compacting) return;
      const view = this.tierAt(d.now());
      const hit = this.refusalFor(view.tier);
      if (hit) return this.refuse(hit, view, "pre_warm", false);
      const ac = new AbortController();
      this.ac = ac;
      let failure: string | null = null;
      const reply = await d.replay(this.captured, ac.signal, (m) => (failure = cleanError(m))).catch((e) => ((failure = cleanError(e instanceof Error ? e.message : e)), null));
      if (gen !== this.gen || ac.signal.aborted) return; // a real request won the race: not recorded
      this.ac = null;
      if (!reply) return this.end("error", failure ?? undefined);
      const line = d.record(reply);
      const u = reply.usage;
      this.touch = d.now();
      this.budget.note({ input: Number(u.input) || 0, output: Number(u.output) || 0, cacheRead: Number(u.cacheRead) || 0, cacheWrite: Number(u.cacheWrite) || 0 });
      this.warmsSent += 1;
      d.trace({ event: "keepalive", outcome: "fired", source: "foreman", reason: view.reason, tier: view.tier, presence: view.presence, cacheRead: Number(u.cacheRead) || 0, cacheWrite: Number(u.cacheWrite) || 0, cost: line?.cost.total ?? (Number(u.cost?.total) || 0) });
      // a completed warm that did not read the cache (cacheRead 0, or more written than read) ends warming for this idle stretch (the next real request opens a new one)
      if (!warmHit({ cacheRead: Number(u.cacheRead) || 0, cacheWrite: Number(u.cacheWrite) || 0 })) {
        this.shared().endedBy = "miss";
        return this.end("self_warm_miss");
      }
      const next = this.nextWarmRefused();
      if (next) return this.refuse(next.hit, next.view, "post_warm", true);
      this.schedule();
    } catch {
      this.end("error");
    }
  }
}
