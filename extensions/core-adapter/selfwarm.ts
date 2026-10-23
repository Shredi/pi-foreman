// Warm owner of the foreman session (docs/cache.md). Holds what both warm paths share: the last cache touch (a real
// request end or a completed warm of either source), the warm budget counters and the away-tick counter; it is the
// WarmGate the idle cache reads for Pi-sent warms. Beyond Pi's 30-minute idle cap (a TTL of 2001 s or more) Pi never warms,
// so this class sends the warm itself: it replays the context captured at `context_with_system` with maxTokens 1 at
// 0.9 x TTL after the last touch, behind the same budget, presence and compaction gates. Never in a child; never while a
// turn runs or a message is queued; an aborted or errored call is not recorded.
import type { CachePolicy } from "./cachepolicy.ts";
import type { Busy, WarmGate } from "./idlecache.ts";
import type { Presence } from "./presence.ts";
import type { Timers } from "./prwatch.ts";
import type { UsageLine } from "./usage.ts";
import { WarmBudget, type Rates } from "./warmbudget.ts";
import { warmCompact, type CompactTrigger } from "./warmcompact.ts";

/** Pi's warm tick: this share of the TTL after the last touch. */
export const WARM_TICK_SHARE = 0.9;

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
  busy(): Busy;
  /** Rates for the current model and a prompt size; null = budget unavailable. */
  rates(promptTokens: number): Rates | null;
  /** The compaction gate behind ctx.compact (idle floor, latch); null = below the floor. */
  compact(): { tier: string; model: string | null } | null;
  trace(r: Record<string, unknown>): void;
  /** Pi's isReplayable rule for the current model and thinking level. */
  replayable(): boolean;
  /** Send the replay with maxTokens 1; null when it errored or was aborted. */
  replay(messages: unknown[], signal: AbortSignal): Promise<WarmReply | null>;
  /** Append the usage line (kind keepalive, source foreman); null when it could not be written. */
  record(reply: WarmReply): UsageLine | null;
}

const realTimers: Timers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

type St = "off" | "watching" | "ended";

export class SelfWarm implements WarmGate {
  private deps: SelfWarmDeps;
  private timers: Timers;
  private timer: unknown = null;
  private st: St = "off";
  private touch: number | null = null;
  private budget = new WarmBudget();
  private awayUsed = 0;
  private captured: unknown[] | null = null;
  private windowEndAt = 0;
  private ac: AbortController | null = null;
  private gen = 0;
  private disabled = false;
  private missChecked = false;
  private compactedForIdle = false;
  private unavailableTraced = false;
  private notReplayableTraced = false;

  constructor(deps: SelfWarmDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? realTimers;
  }

  state(): St {
    return this.st;
  }

  /** Self-warm was switched off for the session by a miss. */
  missed(): boolean {
    return this.disabled;
  }

  // ---- WarmGate -------------------------------------------------------------------------------------------

  owns(): boolean {
    return !this.deps.isChild && !this.disabled && !!this.deps.policy()?.selfWarm;
  }

  lastCacheTouch(): number | null {
    return this.touch;
  }

  budgetAvailable(): boolean {
    return this.deps.policy()?.budgetShare !== undefined && this.deps.rates(this.budget.promptTokens()) !== null && this.budget.promptTokens() > 0;
  }

  verdict(): ReturnType<WarmGate["verdict"]> {
    const p = this.deps.policy();
    if (!p) return { ok: true };
    if (p.awayTicks !== undefined && this.deps.presence.away() && this.awayUsed >= p.awayTicks) return { ok: false, reason: "away" };
    if (p.budgetShare !== undefined) {
      const chk = this.budget.check(this.deps.rates(this.budget.promptTokens()), p.budgetShare);
      if (!chk) {
        if (!this.unavailableTraced) {
          this.unavailableTraced = true;
          this.deps.trace({ event: "keepalive", outcome: "skipped", reason: "budget_unavailable" });
        }
      } else if (!chk.ok) return { ok: false, reason: "budget", budget: { spent: chk.spent, cold: chk.cold, share: p.budgetShare } };
    }
    return { ok: true };
  }

  noteWarm(): void {
    if (this.deps.policy()?.awayTicks !== undefined && this.deps.presence.away()) this.awayUsed += 1;
  }

  armProbe(dueAt: number): void {
    this.deps.presence.armBefore(dueAt);
  }

  disarm(): void {
    this.deps.presence.disarm();
  }

  // ---- state fed by the adapter ---------------------------------------------------------------------------

  /** `context_with_system`: the messages of the request about to be sent (system message first). */
  capture(messages: unknown[]): void {
    this.captured = messages;
  }

  /** A real request ended: the cache was touched, a new idle starts. */
  noteRequest(promptTokens: number): void {
    this.touch = this.deps.now();
    this.budget.reset(promptTokens);
    this.awayUsed = 0;
    this.compactedForIdle = false;
  }

  /** A Pi-sent warm landed in the usage log. */
  noteWarmLine(line: UsageLine): void {
    const at = Date.parse(line.ts);
    if (Number.isFinite(at)) this.touch = Math.max(this.touch ?? 0, at);
    this.budget.note(line);
  }

  /** Compaction or a model change: the provider cache is gone and the budget starts over. */
  invalidate(): void {
    this.abort();
    this.touch = null;
    this.budget.reset(0);
    this.awayUsed = 0;
    this.compactedForIdle = false;
  }

  /** Any activity (input, tool result, child message, agent_start, shutdown): the idle is over. */
  onActivity(): void {
    this.abort();
    this.end("activity");
    this.st = "off";
  }

  onCompact(): void {
    this.invalidate();
    this.end("compact");
  }

  onShutdown(): void {
    this.onActivity();
    this.deps.presence.disarm();
  }

  /** `agent_settled`: open the self-warm window when this session owns the warming. */
  start(): void {
    if (this.st !== "off" || !this.owns() || this.touch === null) return;
    const p = this.deps.policy();
    if (!p) return;
    if (!this.deps.replayable()) {
      if (!this.notReplayableTraced) {
        this.notReplayableTraced = true;
        this.deps.trace({ event: "keepalive", outcome: "skipped", reason: "not_replayable" });
      }
      return;
    }
    const now = this.deps.now();
    this.windowEndAt = now + (p.selfWarmWindowMinutes ?? 45) * 60_000;
    this.st = "watching";
    this.compactedForIdle = false;
    this.schedule();
  }

  // ---- internals -------------------------------------------------------------------------------------------

  private dueAt(): number | null {
    const ttl = this.deps.policy()?.ttlSeconds ?? null;
    return this.touch === null || ttl === null ? null : this.touch + WARM_TICK_SHARE * ttl * 1000;
  }

  private schedule(): void {
    this.timers.clear(this.timer);
    this.timer = null;
    const due = this.dueAt();
    if (this.st !== "watching" || due === null) return;
    this.deps.presence.armBefore(due);
    const gen = this.gen;
    this.timer = this.timers.set(() => void this.fire(gen), Math.max(0, due - this.deps.now()));
  }

  private abort(): void {
    this.gen += 1;
    this.ac?.abort();
    this.ac = null;
  }

  private end(reason: string): void {
    this.timers.clear(this.timer);
    this.timer = null;
    this.deps.presence.disarm();
    if (this.st !== "watching") return;
    this.deps.trace({ event: "keepalive", outcome: "window_end", reason });
    this.st = reason === "activity" || reason === "error" || reason === "shutdown" ? "off" : "ended";
  }

  private compactFor(trigger: CompactTrigger): void {
    if (this.compactedForIdle) return;
    const d = this.deps;
    const p = d.policy();
    if (warmCompact({ policy: p, alreadyCompacted: false, busy: () => this.isBusy(), now: d.now(), lastTouch: this.touch ?? 0, compact: () => d.compact(), trace: (r) => d.trace(r), trigger, skipOutcome: "skipped" })) this.compactedForIdle = true;
  }

  /** A running turn or a queued message; children, waits and launch waits too unless the policy warms while waiting. */
  private isBusy(): boolean {
    const b = this.deps.busy();
    return b.pendingMessages || b.notIdle || (!this.deps.policy()?.whileWaiting && (b.childRun || b.wait || b.launchWait));
  }

  private refuse(reason: "budget" | "away" | "window", budget?: { spent: number; cold: number; share: number }): void {
    if (budget) this.deps.trace({ event: "budget", ...budget });
    if (reason !== "window") this.deps.trace({ event: "keepalive", outcome: "skipped", reason });
    this.compactFor(reason);
    this.end(reason);
  }

  private async fire(gen: number): Promise<void> {
    this.timer = null;
    try {
      if (gen !== this.gen || this.st !== "watching") return;
      const d = this.deps;
      const p = d.policy();
      if (!p || !this.owns() || this.isBusy()) return this.end("activity");
      const due = this.dueAt();
      if (due === null) return this.end("error");
      if (due >= this.windowEndAt) return this.refuse("window");
      const ttlMs = (p.ttlSeconds ?? 0) * 1000;
      if (d.now() > due + (ttlMs - WARM_TICK_SHARE * ttlMs) / 2) {
        d.trace({ event: "keepalive", outcome: "skipped", reason: "late" });
        return this.end("window");
      }
      if (!this.captured || !d.replayable()) {
        d.trace({ event: "keepalive", outcome: "skipped", reason: "not_replayable" });
        return this.end("not_replayable");
      }
      await d.presence.refresh();
      if (gen !== this.gen || this.st !== "watching") return;
      const v = this.verdict();
      if (v.ok === false) return this.refuse(v.reason, v.budget);
      const away = d.presence.away();
      const ac = new AbortController();
      this.ac = ac;
      const reply = await d.replay(this.captured, ac.signal).catch(() => null);
      if (gen !== this.gen || ac.signal.aborted) return; // activity won the race: not recorded, the abort ended the window
      this.ac = null;
      if (!reply) return this.end("activity");
      const line = d.record(reply);
      const u = reply.usage;
      this.touch = d.now();
      this.budget.note({ input: Number(u.input) || 0, output: Number(u.output) || 0, cacheRead: Number(u.cacheRead) || 0, cacheWrite: Number(u.cacheWrite) || 0 });
      if (away && p.awayTicks !== undefined) this.awayUsed += 1;
      d.trace({ event: "keepalive", outcome: "fired", source: "foreman", cacheRead: Number(u.cacheRead) || 0, cacheWrite: Number(u.cacheWrite) || 0, cost: line?.cost.total ?? (Number(u.cost?.total) || 0) });
      if (!this.missChecked) {
        this.missChecked = true;
        if ((Number(u.cacheWrite) || 0) >= (Number(u.cacheRead) || 0)) {
          this.disabled = true;
          return this.end("self_warm_miss");
        }
      }
      this.schedule();
    } catch {
      this.end("error");
    }
  }
}
