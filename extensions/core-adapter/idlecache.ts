// Idle prompt-cache keep-alive (docs/cache.md): Pi's CacheWarmer sends the hidden refresh requests; this
// state machine decides whether the foreman session is eligible (start), answers Pi's
// `cache_warming_decision` hook (decide), watches that the warmer really runs (watchdog, confirm) and
// spends the last warm read on ONE compaction (warm_idle). One unref'd one-shot timer slot per session,
// re-armed to the next absolute deadline (the PendingPanels / PrWatches pattern); clear() at shutdown.
import type { CachePolicy } from "./cachepolicy.ts";
import type { Timers } from "./prwatch.ts";
import { settleGraceMs } from "./selfwarm.ts";
import { coldAt as coldAtTouch, warmCompact } from "./warmcompact.ts";

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
  /** Forced presence probe (no 60 s gap) for the settle check; resolves once the sample is current. */
  refreshPresence?(): Promise<void>;
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
  /** The context is above the idle floor (0.5 x runtime point); no side effects. */
  aboveFloor?(): boolean;
  /** Gate decideIdle + start ctx.compact; the runtime point and model to trace when it started, else null (below the floor). */
  compact(): { point: number | null; model: string | null } | null;
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
/** With a gate: how often the landing of a Pi-sent warm is looked for. */
const POLL_MS = 5000;

type Refusal = { reason: "budget" | "away" | "window"; budget?: { spent: number; cold: number; share: number } };

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
  private gen = 0;
  /** Pi-sent warms of this idle that landed in the usage log (gate only). */
  private landedCount = 0;
  private settleAt = 0;
  private settleChecked = true;
  /** With a gate the window trigger is the post-warm check; the time rule stays only for a window shorter than one tick. */
  private timeRuleOff = false;

  constructor(deps: IdleCacheDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? realTimers;
  }

  state(): IdleState {
    return this.st;
  }

  /** Read-only state for the footer's cache bar: the next Pi-sent warm is one Pi tick after the last decision (else the window start). */
  snapshot(): { state: IdleState; windowEndAt: number; nextWarmAt: number | null } {
    const ttl = this.deps.policy()?.ttlSeconds ?? null;
    const landed = this.deps.gate && this.lastKeepaliveAt !== null && this.lastKeepaliveAt >= this.startedAt ? this.lastKeepaliveAt : null;
    const next = this.st === "watching" && ttl !== null ? (landed ?? this.lastDecisionAt ?? this.startedAt) + Math.min(0.9 * ttl, ttl - 10) * 1000 : null;
    return { state: this.st, windowEndAt: this.windowEndAt, nextWarmAt: next };
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
    this.timeRuleOff = !!d.gate && span > interval;
    this.compactChecked = false;
    this.compactedForIdle = false;
    this.lastDecisionAt = undefined;
    this.oldestUnconfirmedFireAt = undefined;
    this.gen += 1;
    this.landedCount = 0;
    this.settleAt = now + settleGraceMs(policy.ttlSeconds);
    this.settleChecked = !d.gate;
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
    this.gen += 1;
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
    this.deps.trace({ event: "keepalive", outcome: "skipped", reason, count: this.landedCount, phase: "pre_warm" });
    if (!this.compactedForIdle) this.tryCompact(now, reason);
    this.end(reason);
  }

  /** No further warm: the gate refuses (state after the last cache touch) or, after a landed warm, Pi's next tick falls at or past the window end. */
  private refusalHit(withWindow: boolean): Refusal | null {
    const g = this.deps.gate;
    if (!g) return null;
    const v = g.verdict();
    if (v.ok === false) return { reason: v.reason, budget: v.budget };
    const ttl = this.deps.policy()?.ttlSeconds;
    if (withWindow && typeof ttl === "number" && (this.lastKeepaliveAt ?? 0) + Math.min(0.9 * ttl, ttl - 10) * 1000 >= this.windowEndAt) return { reason: "window" };
    return null;
  }

  /** Act on a refusal hit: budget/away compact and end the window at once; window compacts and keeps watching until `onCompact` (or ends when declined). */
  private onHit(hit: Refusal, phase: "settle" | "post_warm", now: number): void {
    if (hit.reason === "window") {
      if (!this.compactChecked) {
        this.compactChecked = true;
        this.tryCompact(now);
      }
      if (!this.compactedForIdle) this.end("window");
      return;
    }
    if (hit.budget) this.deps.trace({ event: "budget", ...hit.budget });
    this.deps.trace({ event: "keepalive", outcome: "skipped", reason: hit.reason, count: this.landedCount, phase });
    if (!this.compactedForIdle) this.tryCompact(now, hit.reason);
    this.end(hit.reason);
  }

  /** Zero allowed warms (budget or away): once, after the grace and a forced presence probe, unless Pi has decided a warm in this window. */
  private settleCheck(): void {
    this.settleChecked = true;
    const g = this.deps.gate;
    if (!g || this.lastDecisionAt !== undefined) return;
    const run = (): void => {
      if (this.lastDecisionAt !== undefined) return;
      const hit = this.refusalHit(false);
      if (hit) this.onHit(hit, "settle", this.deps.now());
    };
    if (!g.refreshPresence) return run();
    const gen = this.gen;
    void g
      .refreshPresence()
      .catch(() => undefined)
      .then(() => {
        if (gen !== this.gen || this.st !== "watching") return;
        try {
          run();
        } catch {
          this.end("error");
        }
      });
  }

  /** Cold bound of the last cache touch (ms): a window kept open past its end for a running compaction ends here at the latest. */
  private boundAt(): number {
    const d = this.deps;
    const ttl = d.policy()?.ttlSeconds;
    const touch = Math.max(this.lastKeepaliveAt ?? 0, d.lastAssistantAt() ?? 0, d.gate?.lastCacheTouch() ?? 0);
    return typeof ttl !== "number" || touch === 0 ? d.now() : coldAtTouch(touch, ttl);
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
    const now = this.deps.now();
    const past = !!g && now >= this.windowEndAt;
    const winding = !!g && (past || this.compactedForIdle);
    let next = past ? Infinity : this.windowEndAt;
    if (!winding) next = Math.min(next, this.watchdogAt());
    if (this.oldestUnconfirmedFireAt !== undefined) {
      next = Math.min(next, this.oldestUnconfirmedFireAt + CONFIRM_MS);
      if (g) next = Math.min(next, now + POLL_MS);
    }
    if (!this.compactChecked && !this.timeRuleOff) next = Math.min(next, this.compactAt);
    if (g && !this.settleChecked) next = Math.min(next, this.settleAt);
    if (winding && this.oldestUnconfirmedFireAt === undefined) next = Math.min(next, this.boundAt());
    this.timer = this.timers.set(() => this.wake(), Math.max(0, next - now));
  }

  private wake(): void {
    this.timer = null;
    try {
      if (this.st !== "watching") return;
      const sync = this.deps.syncKeepalives();
      if (sync.lastReadAt !== null) this.lastKeepaliveAt = Math.max(this.lastKeepaliveAt ?? 0, sync.lastReadAt);
      const now = this.deps.now();
      const g = this.deps.gate;
      if (this.oldestUnconfirmedFireAt !== undefined && this.lastKeepaliveAt !== null && this.lastKeepaliveAt >= this.oldestUnconfirmedFireAt) {
        this.oldestUnconfirmedFireAt = undefined;
        if (g) {
          this.landedCount += 1;
          const hit = this.refusalHit(true);
          if (hit) this.onHit(hit, "post_warm", now);
          if (this.st !== "watching") return;
        }
      }
      if (g && !this.settleChecked && now >= this.settleAt) {
        this.settleCheck();
        if (this.st !== "watching") return;
      }
      if (now >= this.windowEndAt) {
        if (!g) return this.end("window");
        if (!this.compactedForIdle && this.oldestUnconfirmedFireAt === undefined) {
          if (!this.compactChecked) {
            this.compactChecked = true;
            this.tryCompact(now);
          }
          if (!this.compactedForIdle) return this.end("window");
        }
      }
      const winding = !!g && (now >= this.windowEndAt || this.compactedForIdle);
      if (!winding && now >= this.watchdogAt()) return this.end("warmer_stopped");
      if (this.oldestUnconfirmedFireAt !== undefined && now >= this.oldestUnconfirmedFireAt + CONFIRM_MS) return this.end("warmer_stopped");
      if (winding && this.oldestUnconfirmedFireAt === undefined && now >= this.boundAt()) return this.end("window");
      if (!this.compactChecked && !this.timeRuleOff && now >= this.compactAt) {
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
      aboveFloor: d.aboveFloor ? () => d.aboveFloor!() : undefined,
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
