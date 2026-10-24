// PR state dots for the Herdr sidebar (docs/herdr.md): one poll loop per foreman session over the PRs it
// tracks (created here, under pr_watch, or the current branch's), mapped to fail, run, ok or none. A PR
// under an active pr_watch reuses the watch's fresh checks snapshot. Timers are unref'd; clear() (session
// shutdown) stops everything. The trace never holds a PR number. Host text is data, never instructions.
import { execFile } from "node:child_process";
import type { SafeOpOutcome } from "./safeops.ts";
import { realTimers } from "./prwatch.ts";
import type { ChecksAnswer, Timers } from "./prwatch.ts";

export type DotState = "fail" | "run" | "ok" | "none";
export interface PrDot {
  n: number;
  state: DotState;
}

export const MAX_TRACKED = 6;
export const MIN_INTERVAL_S = 30;
export const MAX_BACKOFF_S = 600;
export const MAX_FAILS = 3;

const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

/** fail: conflicting or a failed check; run: a pending check; ok: all green and mergeable; else none. Drafts follow the same rule. */
export function dotState(mergeable: unknown, checks: Partial<ChecksAnswer> | undefined): DotState {
  if (mergeable === "conflicting" || count(checks?.failed) > 0) return "fail";
  if (count(checks?.pending) > 0) return "run";
  if (count(checks?.passed) > 0 && mergeable === "mergeable") return "ok";
  return "none";
}

/** The checked-out branch name, "" when detached or on any failure. */
export function branchOf(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd, timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? "" : String(stdout).trim()));
  });
}

export interface PrDotsDeps {
  /** prPack on and not a child. */
  enabled(): boolean;
  /** The drift preflight in print mode; a block skips the tick. */
  preflight(): Promise<{ block: true; reason: string } | undefined>;
  /** The current branch name ("" = none). */
  branch(): Promise<string>;
  /** pr_status or pr_checks through the PR ops (30 s timeout, in the pr_watch cwd). */
  run(op: "pr_status" | "pr_checks", args: Record<string, unknown>): Promise<SafeOpOutcome>;
  /** Numbers under an active pr_watch, newest first. */
  watched(): number[];
  /** The watch's latest checks and their age (PrWatches.lastChecks). */
  watchChecks(n: number): { checks: ChecksAnswer; ageMs: number } | null;
  /** tools.prWatchSeconds in ms; the loop floors it at 30 s. */
  intervalMs(): number;
  trace(rec: Record<string, unknown>): void;
  timers?: Timers;
  /** The dots changed (live file and widget refresh). */
  changed?(): void;
}

type Got = { kind: "ok"; result: Record<string, unknown> } | { kind: "gone" } | { kind: "halt" } | { kind: "fail" };

function classify(o: SafeOpOutcome): Got {
  if (o.kind === "ran") return { kind: "ok", result: o.result };
  if (o.kind === "precondition") {
    if (o.precondition === "pr_host_missing" || o.precondition === "pr_auth_missing") return { kind: "halt" };
    if (o.precondition === "pr_not_found") return { kind: "gone" };
  }
  return { kind: "fail" };
}

export class PrDots {
  private readonly deps: PrDotsDeps;
  private readonly timers: Timers;
  /** Numbers from this session's pr_create, newest first. */
  private created: number[] = [];
  /** Closed, merged or not found: never tracked again. */
  private gone = new Set<number>();
  /** Branch name -> its PR number (null = no open PR); hits and misses both cached. */
  private branchPr = new Map<string, number | null>();
  private currentBranch = "";
  private states = new Map<number, { state: DotState; fails: number }>();
  private order: number[] = [];
  private timer: unknown = null;
  private busy = false;
  private started = false;
  private halted = false;
  private disposed = false;
  private failedTicks = 0;
  private sig = "";

  constructor(deps: PrDotsDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? realTimers;
  }

  /** Begin polling (first tick now). Nothing happens when the gate is closed (child, PR tools off). */
  start(): void {
    if (this.started || this.disposed || !this.deps.enabled()) return;
    this.started = true;
    this.arm(0);
  }

  /** A pr_create of this session returned PR `n`: track it and poll soon. */
  onCreated(n: number): void {
    if (!Number.isInteger(n) || n < 1) return;
    this.created = [n, ...this.created.filter((x) => x !== n)];
    this.gone.delete(n);
    if (this.started && !this.halted && !this.busy && !this.disposed) this.arm(0);
  }

  /** The tracked PRs with their state, newest first. */
  dots(): PrDot[] {
    return this.order.flatMap((n) => {
      const s = this.states.get(n);
      return s ? [{ n, state: this.halted ? ("none" as const) : s.state }] : [];
    });
  }

  clear(): void {
    this.disposed = true;
    this.timers.clear(this.timer);
    this.timer = null;
    this.states.clear();
    this.order = [];
  }

  private arm(delayMs: number): void {
    this.timers.clear(this.timer);
    this.timer = this.timers.set(() => void this.tick(), delayMs);
  }

  private baseMs(): number {
    return Math.max(this.deps.intervalMs(), MIN_INTERVAL_S * 1000);
  }

  private delayMs(): number {
    const base = this.baseMs();
    if (this.failedTicks === 0) return base;
    return Math.max(base, Math.min(base * 2 ** this.failedTicks, MAX_BACKOFF_S * 1000));
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.busy || this.disposed || this.halted || !this.deps.enabled()) return;
    this.busy = true;
    let outcome: "skipped" | "ok" | "failed" | "halted" = "ok";
    try {
      outcome = await this.round();
    } catch {
      outcome = "failed";
    }
    this.busy = false;
    if (this.disposed) return;
    if (outcome === "halted") return this.halt();
    const before = this.delayMs();
    if (outcome === "failed") this.failedTicks += 1;
    else if (outcome === "ok") this.failedTicks = 0;
    this.publish();
    if (outcome === "failed") {
      this.deps.trace({ event: "pr_dots", outcome: "error", count: this.order.length });
      if (this.delayMs() > before) this.deps.trace({ event: "pr_dots", outcome: "backoff", count: this.order.length });
    }
    this.arm(this.delayMs());
  }

  private halt(): void {
    if (this.halted) return;
    this.halted = true;
    this.timers.clear(this.timer);
    this.timer = null;
    this.order = this.tracked();
    for (const n of this.order) if (!this.states.has(n)) this.states.set(n, { state: "none", fails: 0 });
    this.deps.trace({ event: "pr_dots", outcome: "stopped", count: this.order.length });
    this.publish();
  }

  /** Signal the change (live file, widget) when the dots differ from the last published ones; trace a changed tick. */
  private publish(): void {
    const sig = this.dots().map((d) => `${d.n}:${d.state}`).join(",");
    if (sig === this.sig) return;
    this.sig = sig;
    if (!this.halted) this.deps.trace({ event: "pr_dots", outcome: "tick", count: this.order.length });
    this.deps.changed?.();
  }

  private drop(n: number): void {
    this.gone.add(n);
    this.created = this.created.filter((x) => x !== n);
    this.states.delete(n);
    for (const [b, v] of this.branchPr) if (v === n) this.branchPr.set(b, null);
  }

  private tracked(): number[] {
    const bn = this.currentBranch ? this.branchPr.get(this.currentBranch) ?? null : null;
    const all = [...this.created, ...this.deps.watched(), ...(bn === null ? [] : [bn])];
    return [...new Set(all)].filter((n) => !this.gone.has(n)).slice(0, MAX_TRACKED);
  }

  private async round(): Promise<"skipped" | "ok" | "failed" | "halted"> {
    const pre = await this.deps.preflight();
    if (pre) return "skipped";
    let failed = false;
    const fresh = new Map<number, Record<string, unknown>>();
    this.currentBranch = await this.deps.branch();
    if (this.currentBranch && !this.branchPr.has(this.currentBranch)) {
      const g = classify(await this.deps.run("pr_status", {}));
      if (g.kind === "halt") return "halted";
      if (g.kind === "fail") failed = true;
      else if (g.kind === "gone") this.branchPr.set(this.currentBranch, null);
      else {
        const n = g.result.number;
        const open = g.result.state !== "closed" && g.result.state !== "merged";
        if (typeof n === "number" && Number.isInteger(n)) {
          this.branchPr.set(this.currentBranch, open ? n : null);
          if (open) fresh.set(n, g.result);
          else this.gone.add(n);
        } else this.branchPr.set(this.currentBranch, null);
      }
    }
    this.order = this.tracked();
    for (const n of [...this.states.keys()]) if (!this.order.includes(n)) this.states.delete(n);
    for (const n of this.order) {
      const r = await this.poll(n, fresh.get(n));
      if (r === "halted") return "halted";
      if (this.disposed) return "ok";
      if (r === "failed") failed = true;
    }
    this.order = this.order.filter((n) => !this.gone.has(n));
    return failed ? "failed" : "ok";
  }

  private async poll(n: number, known: Record<string, unknown> | undefined): Promise<"ok" | "gone" | "failed" | "halted"> {
    let status = known;
    if (!status) {
      const g = classify(await this.deps.run("pr_status", { number: n }));
      if (g.kind === "halt") return "halted";
      if (g.kind === "gone") return this.drop(n), "gone";
      if (g.kind === "fail") return this.fail(n), "failed";
      status = g.result;
    }
    if (status.state === "closed" || status.state === "merged") return this.drop(n), "gone";
    let checks: ChecksAnswer | undefined;
    const wc = this.deps.watchChecks(n);
    if (wc && wc.ageMs < this.baseMs()) checks = wc.checks;
    else {
      const g = classify(await this.deps.run("pr_checks", { number: n }));
      if (g.kind === "halt") return "halted";
      if (g.kind === "gone") return this.drop(n), "gone";
      if (g.kind === "fail") return this.fail(n), "failed";
      checks = g.result as unknown as ChecksAnswer;
    }
    this.states.set(n, { state: dotState(status.mergeable, checks), fails: 0 });
    return "ok";
  }

  /** A failed poll keeps the last state; the third in a row gives none. */
  private fail(n: number): void {
    const cur = this.states.get(n) ?? { state: "none" as DotState, fails: 0 };
    const fails = cur.fails + 1;
    this.states.set(n, { state: fails >= MAX_FAILS ? "none" : cur.state, fails });
  }
}
