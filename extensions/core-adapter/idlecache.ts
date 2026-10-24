// Idle prompt-cache keep-alive (docs/cache.md): Pi's CacheWarmer sends the hidden refresh requests; this
// state machine decides whether the foreman session is eligible (start), answers Pi's
// `cache_warming_decision` hook (decide), watches that the warmer really runs (watchdog, confirm) and
// spends the last warm read on ONE compaction (warm_idle). One unref'd one-shot timer slot per session,
// re-armed to the next absolute deadline (the PendingPanels / PrWatches pattern); clear() at shutdown.
import type { CachePolicy } from "./cachepolicy.ts";
import type { Timers } from "./prwatch.ts";
import { warmCompact } from "./warmcompact.ts";

export type IdleState = "off" | "watching" | "ended";
export type EndReason = "window" | "compact" | "activity" | "shutdown" | "warmer_stopped" | "error" | "hook_stop" | "budget" | "away";

/** Budget and presence gate of the warm policy (selfwarm.ts implements it); optional, absent = the legacy behaviour. */
export interface WarmGate {
  /** Verdict for the next Pi-sent warm, from the cached presence sample; synchronous, no side effects. */
  verdict(): { ok: true } | { ok: false; reason: "budget" | "away"; budget?: { spent: number; cold: number; share: number } };
  /** A budget can be computed (prompt size and rates known). */
  budgetAvailable(): boolean;
  /** Latest real request end or completed warm (either source), ms; null = unknown. */
  lastCacheTouch(): number | null;
  /** pi-foreman sends the warms itself; the idle cache stays out. */
  owns(): boolean;
  /** A warm was allowed (counts an away tick when the owner is away). */
  noteWarm(): void;
  /** Background presence probe shortly before `dueAt`. */
  armProbe(dueAt: number): void;
  disarm(): void;
}

export interface Busy {
  childRun: boolean;
  wait: boolean;
  launchWait: boolean;
  pendingMessages: boolean;
  /** Pi reports the session as not idle (a run is in flight). */
  notIdle: boolean;
}

export interface KeepaliveSync {
  newEntries: number;
  /** Timestamp (ms) of the latest keep-alive entry seen so far, null when none. */
  lastReadAt: number | null;
}

export interface IdleCacheDeps {
  now(): number;
  timers?: Timers;
  policy(): CachePolicy | null;
  /** Pi's `cacheWarming` setting is "idle". */
  piIdleMode(): boolean;
  /** The active model declares `promptCache`. */
  hasPromptCache(): boolean;
  busy(): Busy;
  trace(ev: Record<string, unknown>): void;
  /** Context tokens for the compactMinTokens gate; absent or null = unknown. */
  contextTokens?(): number | null;
  /** Gate decideIdle + start ctx.compact; the tier and model to trace when it started, else null (below the floor). */
  compact(): { tier: string; model: string | null } | null;
  setGlyph(on: boolean): void;
  syncKeepalives(): KeepaliveSync;
  lastAssistantAt(): number | null;
  isChild: boolean;
  gate?: WarmGate;
}

/** Pi stops idle warming this long after the last real request. */
export const PI_IDLE_CAP_MS = 30 * 60 * 1000;
const CONFIRM_MS = 90 * 1000;
const WATCHDOG_SLACK_S = 60;

const realTimers: Timers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class IdleCache {
  private deps: IdleCacheDeps;
  private timers: Timers;
  private st: IdleState = "off";
  private timer: unknown = null;
  private glyph = false;
  private skipTraced = new Set<string>();
  private busyTraced = false;
  private startedAt = 0;
  private windowEndAt = 0;
  private compactAt = 0;
  private compactChecked = false;
  private compactedForIdle = false;
  private lastDecisionAt: number | undefined;
  private oldestUnconfirmedFireAt: number | undefined;
  private lastKeepaliveAt: number | null = null;
  private lastTurnStartAt: number | null = null;
  private refusal: "budget" | "away" | null = null;

  constructor(deps: IdleCacheDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? realTimers;
  }

  state(): IdleState {
    return this.st;
  }

  /** Record a turn start (Pi's idle cap counts from the last real request). */
  noteTurnStart(at: number): void {
    this.lastTurnStartAt = at;
  }

  /** `agent_settled`, foreman only. */
  start(): void {
    const d = this.deps;
    if (d.isChild) return;
    if (this.st !== "off") return;
    const policy = d.policy();
    if (!policy || policy.skip === "no_entry") return;
    if (policy.selfWarm && d.gate?.owns()) return;
    if (!policy.active || policy.skip) return this.skipOnce(policy.skip ?? "disabled");
    if (!d.piIdleMode()) return this.skipOnce("pi_mode_not_idle");
    if (!d.hasPromptCache()) return this.skipOnce("no_prompt_cache");
    if (busyFor(d.busy(), policy)) {
      if (!this.busyTraced) {
        this.busyTraced = true;
        d.trace({ event: "keepalive", outcome: "skipped", reason: "busy" });
      }
      return;
    }
    const now = d.now();
    const interval = policy.intervalSeconds * 1000;
    this.startedAt = now;
    this.windowEndAt = Math.min(now + policy.effectiveWindowMinutes * 60_000, (this.lastTurnStartAt ?? now) + PI_IDLE_CAP_MS);
    const span = this.windowEndAt - now;
    this.compactAt = span <= interval ? now + span / 2 : this.windowEndAt - interval;
    this.compactChecked = false;
    this.compactedForIdle = false;
    this.lastDecisionAt = undefined;
    this.oldestUnconfirmedFireAt = undefined;
    this.st = "watching";
    this.setGlyph(true);
    this.arm();
  }

  /** `agent_start`: a new run; the previous idle is over. */
  onAgentStart(): void {
    this.end("activity");
    this.busyTraced = false;
  }

  /** Any user input, tool result, or child/intercom/wake message. */
  onActivity(): void {
    this.end("activity");
  }

  onCompact(): void {
    this.end("compact");
  }

  onShutdown(): void {
    this.end("shutdown");
    this.clear();
  }

  clear(): void {
    this.timers.clear(this.timer);
    this.timer = null;
    this.setGlyph(false);
    this.st = "off";
  }

  /** Idempotent. Traces only when it ends a watching window. */
  end(reason: EndReason): void {
    const was = this.st;
    this.timers.clear(this.timer);
    this.timer = null;
    this.deps.gate?.disarm();
    this.setGlyph(false);
    const stays = reason === "window" || reason === "compact" || reason === "budget" || reason === "away";
    if (was === "watching") {
      this.deps.trace({ event: "keepalive", outcome: "window_end", reason });
      this.st = stays ? "ended" : "off";
    } else if (!stays) this.st = "off";
  }

  /** After Pi's `cache_warming_decision` hook answered. */
  noteDecision(action: "warm" | "stop" | undefined): void {
    if (this.st !== "watching") return;
    if (action === "stop") {
      const why = this.refusal;
      this.refusal = null;
      if (why) return this.refuse(why);
      return this.end("hook_stop");
    }
    if (action !== "warm") return;
    this.deps.gate?.noteWarm();
    const now = this.deps.now();
    this.lastDecisionAt = now;
    if (this.oldestUnconfirmedFireAt === undefined) this.oldestUnconfirmedFireAt = now;
    this.arm();
  }

  /** Answer for the hook (R1-R5); synchronous. A gate refusal sets `refusal` and, for the budget, emits a `budget` trace. */
  decide(busy: Busy): "warm" | "stop" | undefined {
    this.refusal = null;
    if (busyFor(busy, this.deps.policy())) return undefined;
    if (this.st === "watching") {
      if (!(this.deps.now() < this.windowEndAt && !this.compactedForIdle)) return undefined;
      const v = this.deps.gate?.verdict();
      if (v && v.ok === false) {
        this.refusal = v.reason;
        if (v.budget) this.deps.trace({ event: "budget", ...v.budget });
        return "stop";
      }
      return "warm";
    }
    if (this.st === "ended") return "stop";
    return undefined;
  }

  /** The gate refused the next warm: say why, spend the last warm read on one compaction, end the window. */
  private refuse(reason: "budget" | "away"): void {
    const now = this.deps.now();
    this.deps.trace({ event: "keepalive", outcome: "skipped", reason });
    if (!this.compactedForIdle) this.tryCompact(now, reason);
    this.end(reason);
  }

  private skipOnce(reason: string): void {
    if (this.skipTraced.has(reason)) return;
    this.skipTraced.add(reason);
    this.deps.trace({ event: "keepalive", outcome: "skipped", reason });
  }

  private setGlyph(on: boolean): void {
    if (this.glyph === on) return;
    this.glyph = on;
    try {
      this.deps.setGlyph(on);
    } catch {
      // cosmetic
    }
  }

  private watchdogAt(): number {
    const p = this.deps.policy();
    const interval = p?.intervalSeconds ?? 0;
    const ttl = p?.ttlSeconds ?? 0;
    const piTick = Math.min(0.9 * ttl, ttl - 10);
    return (this.lastDecisionAt ?? this.startedAt) + (Math.max(interval, piTick) + WATCHDOG_SLACK_S) * 1000;
  }

  private arm(): void {
    this.timers.clear(this.timer);
    this.timer = null;
    if (this.st !== "watching") return;
    const g = this.deps.gate;
    const p = this.deps.policy();
    if (g && p) g.armProbe((this.lastDecisionAt ?? this.startedAt) + p.intervalSeconds * 1000);
    let next = Math.min(this.windowEndAt, this.watchdogAt());
    if (this.oldestUnconfirmedFireAt !== undefined) next = Math.min(next, this.oldestUnconfirmedFireAt + CONFIRM_MS);
    if (!this.compactChecked) next = Math.min(next, this.compactAt);
    this.timer = this.timers.set(() => this.wake(), Math.max(0, next - this.deps.now()));
  }

  private wake(): void {
    this.timer = null;
    try {
      if (this.st !== "watching") return;
      const sync = this.deps.syncKeepalives();
      if (sync.lastReadAt !== null) this.lastKeepaliveAt = Math.max(this.lastKeepaliveAt ?? 0, sync.lastReadAt);
      const now = this.deps.now();
      if (this.oldestUnconfirmedFireAt !== undefined && this.lastKeepaliveAt !== null && this.lastKeepaliveAt >= this.oldestUnconfirmedFireAt) this.oldestUnconfirmedFireAt = undefined;
      if (now >= this.windowEndAt) return this.end("window");
      if (now >= this.watchdogAt()) return this.end("warmer_stopped");
      if (this.oldestUnconfirmedFireAt !== undefined && now >= this.oldestUnconfirmedFireAt + CONFIRM_MS) return this.end("warmer_stopped");
      if (!this.compactChecked && now >= this.compactAt) {
        this.compactChecked = true;
        this.tryCompact(now);
      }
      this.arm();
    } catch {
      this.end("error");
    }
  }

  private tryCompact(now: number, trigger?: "budget" | "away"): void {
    const d = this.deps;
    const p = d.policy();
    const fired = warmCompact({
      policy: p,
      alreadyCompacted: this.compactedForIdle,
      busy: () => busyFor(d.busy(), p),
      now,
      lastTouch: Math.max(this.lastKeepaliveAt ?? 0, d.lastAssistantAt() ?? 0, d.gate?.lastCacheTouch() ?? 0),
      contextTokens: d.contextTokens ? () => d.contextTokens!() : undefined,
      compact: () => d.compact(),
      trace: (r) => d.trace(r),
      trigger: trigger ?? (p?.budgetShare !== undefined ? "window" : undefined),
      skipOutcome: trigger ? "skipped" : "window_end",
    });
    if (fired) this.compactedForIdle = true;
  }
}

/** What keeps a warm from being sent; children, waits and launch waits only count unless the policy lets warming go on while waiting. */
function busyFor(b: Busy, p: CachePolicy | null): boolean {
  return b.pendingMessages || b.notIdle || (!p?.whileWaiting && (b.childRun || b.wait || b.launchWait));
}
