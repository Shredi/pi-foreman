// PR state dots for the Herdr sidebar (docs/herdr.md) and the PR views behind them: one poll loop per foreman
// session over the PRs it tracks (prtrack.ts: pushed branches, author search, commands acted on, events, created
// here, URLs, pr_track, pr_watch, the current branch's), mapped to fail, run, ok or none. On gh one GraphQL
// batch per host and tick returns every tracked PR; other hosts get pr_status and pr_checks per PR. A PR under
// an active pr_watch reuses the watch's fresh checks snapshot on that path. Timers are unref'd; clear()
// (session shutdown) stops everything. The trace never holds a PR number. Host text is data, never instructions.
import { execFile } from "node:child_process";
import path from "node:path";
import type { PrOp } from "./gitpack.ts";
import type { SafeOpOutcome } from "./safeops.ts";
import { realTimers } from "./prwatch.ts";
import type { ChecksAnswer, Timers } from "./prwatch.ts";
import { MAX_PUSHED, MAX_TRACKED, PrRegistry, branchWithUpstream, chainSegments, compilePatterns, detectInteraction, keyString, matchPatterns, parsePrUrl, parsePush, parsePushOutput, registerTouched, remoteHostsOf, sameRepo, scanUrls, validHost, validNumber, validRepo } from "./prtrack.ts";
import type { Interaction, Pushed, PrKey, PrSource, Registered } from "./prtrack.ts";

export { MAX_TRACKED };
export type DotState = "fail" | "run" | "ok" | "none";
export interface PrDot {
  n: number;
  state: DotState;
  /** `owner/name#n` cut to 20 characters; only for a PR of another repository (the sidebar shows `#n` otherwise). */
  label?: string;
}

export const MIN_INTERVAL_S = 30;
export const MAX_BACKOFF_S = 600;
export const MAX_FAILS = 3;
export const CLOSED_VIEW_MS = 60_000;
export const MAX_NAMES = 10;
export const FIND_AGAIN_MS = 5 * 60_000;
export const NOTICE_REEVAL_MS = 10 * 60_000;
const MAX_LABEL = 20;

const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

/** fail: conflicting or a failed check; run: a running or missing check; ok: all green and mergeable; else none. Drafts follow the same rule. */
export function dotState(mergeable: unknown, checks: (Partial<ChecksAnswer> & { missing?: unknown[] }) | undefined): DotState {
  return dotFromCounts(mergeable, count(checks?.failed), count(checks?.pending) + count(checks?.missing), count(checks?.passed));
}

function dotFromCounts(mergeable: unknown, failed: number, waiting: number, passed: number): DotState {
  if (mergeable === "conflicting" || failed > 0) return "fail";
  if (waiting > 0) return "run";
  if (passed > 0 && mergeable === "mergeable") return "ok";
  return "none";
}

/** Whether the dots poller runs: the PR pack is on, this is the foreman, and tools.prDots is not false (absent = true). */
export function prDotsEnabled(prPack: boolean, isChild: boolean, prDots: unknown): boolean {
  return prPack && !isChild && prDots !== false;
}

/** The checked-out branch name, "" when detached or on any failure. */
export function branchOf(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd, timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? "" : String(stdout).trim()));
  });
}

/** Host text as display data: control and format characters removed, cut. */
export function cleanText(v: unknown, max = 200): string {
  return typeof v === "string" ? v.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, max) : "";
}

export interface PrChecksView {
  running: string[];
  failed: string[];
  missing: string[];
  passed: string[];
  counts: { running: number; failed: number; missing: number; passed: number };
  truncated: boolean;
}
export interface PrView {
  key: PrKey;
  id: string;
  /** `#n` for the current repository, else `owner/name#n`. */
  label: string;
  foreign: boolean;
  url: string | null;
  title: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  mergeable: string | null;
  reviewDecision: string | null;
  source: PrSource;
  checks: PrChecksView;
  dot: DotState;
  changedAt: number;
  closedAt?: number;
}

interface Repo {
  host: string;
  repo: string;
}
const NO_REPO: Repo = { host: "", repo: "" };

export interface PrDotsDeps {
  /** prPack on and not a child. */
  enabled(): boolean;
  /** The drift preflight in print mode; a block skips the tick. */
  preflight(): Promise<{ block: true; reason: string } | undefined>;
  /** The current branch name ("" = none). */
  branch(): Promise<string>;
  /** A PR op (30 s timeout), in `cwd` (default: the pr_watch cwd). */
  run(op: PrOp, args: Record<string, unknown>, cwd?: string): Promise<SafeOpOutcome>;
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
  /** Registration trace (`pr_track`); default: none. */
  traceTrack?(rec: Record<string, unknown>): void;
  /** The session cwd. */
  cwd?(): string;
  /** Run `pr_repo` once per cwd and key number-only registrations by its answer (off: they key on an empty repository). */
  repoLookup?: boolean;
  /** Run the push lookups and the author search. */
  discover?: boolean;
  /** Poll with one pr_batch per host (falls back when the host answers pr_unsupported). */
  batch?: boolean;
  now?(): number;
  /** `tools.prInteractions` (user or overlay layer). */
  interactions?(): unknown;
  /** Hosts of the checkout's remotes. */
  remoteHosts?(cwd: string): Promise<string[]>;
  /** The branch of a quiet push (default: the checkout's branch when it has an upstream). */
  quietBranch?(cwd: string): Promise<string>;
  /** The configured base branch (safety.ops.baseBranch), if any. */
  baseBranch?(): string | null;
  /** Is the pushed branch in the base branch? null: cannot tell (no ref), no notice. */
  merged?(cwd: string, remote: string, name: string): Promise<boolean | null>;
}

type Got = { kind: "ok"; result: Record<string, unknown> } | { kind: "gone" } | { kind: "halt" } | { kind: "unsupported" } | { kind: "fail" };

function classify(o: SafeOpOutcome): Got {
  if (o.kind === "ran") return { kind: "ok", result: o.result };
  if (o.kind === "precondition") {
    if (o.precondition === "pr_host_missing" || o.precondition === "pr_auth_missing") return { kind: "halt" };
    if (o.precondition === "pr_not_found") return { kind: "gone" };
    if (o.precondition === "pr_unsupported") return { kind: "unsupported" };
  }
  return { kind: "fail" };
}

const names = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap((x) => (typeof x === "string" ? [cleanText(x, 120)] : x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string" ? [cleanText((x as { name: string }).name, 120)] : [])) : []);

function checksView(c: Record<string, unknown> | undefined): PrChecksView {
  const groups = { running: names(c?.pending), failed: names(c?.failed), missing: names(c?.missing), passed: names(c?.passed) };
  const cnt = c?.counts as Record<string, unknown> | undefined;
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : fallback);
  return {
    running: groups.running.slice(0, MAX_NAMES),
    failed: groups.failed.slice(0, MAX_NAMES),
    missing: groups.missing.slice(0, MAX_NAMES),
    passed: groups.passed.slice(0, MAX_NAMES),
    counts: { running: num(cnt?.pending, groups.running.length), failed: num(cnt?.failed, groups.failed.length), missing: num(cnt?.missing, groups.missing.length), passed: num(cnt?.passed, groups.passed.length) },
    truncated: c?.truncated === true,
  };
}

interface Slot {
  state: DotState;
  fails: number;
  view: PrView | null;
}

export class PrDots {
  private readonly deps: PrDotsDeps;
  private readonly timers: Timers;
  private readonly reg = new PrRegistry();
  private readonly pushed: Pushed[] = [];
  /** Branch name -> the PR key of its open PR (null = none); hits and misses both cached. */
  private branchPr = new Map<string, PrKey | null>();
  private currentBranch = "";
  private states = new Map<string, Slot>();
  private closed = new Map<string, PrView>();
  private order: PrKey[] = [];
  private repos = new Map<string, Promise<Repo | null>>();
  private repoNow = new Map<string, Repo | null>();
  private remotes = new Map<string, Promise<string[]>>();
  private patterns: { src: unknown; re: RegExp[] } = { src: undefined, re: [] };
  private timer: unknown = null;
  private busy = false;
  private started = false;
  private halted = false;
  private disposed = false;
  private batchOff = false;
  private failedTicks = 0;
  private tickNo = 0;
  private sig = "";
  private noticeRunning = false;
  private noticed = new Map<string, { at: number; final: boolean }>();

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

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  // ---------------------------------------------------------------- identity

  private mainCwd(): string {
    return this.deps.cwd?.() ?? "";
  }

  /** The host-resolved repository of `cwd`, asked once per cwd (null: unknown). */
  repoFor(cwd: string): Promise<Repo | null> {
    if (!this.deps.repoLookup) {
      this.repoNow.set(cwd, NO_REPO);
      return Promise.resolve(NO_REPO);
    }
    let p = this.repos.get(cwd);
    if (!p) {
      p = this.deps.run("pr_repo", {}, cwd || undefined).then(
        (o) => {
          const r = o.kind === "ran" ? o.result : null;
          const found = r && validHost(r.host) && validRepo(r.repo) ? { host: String(r.host), repo: String(r.repo) } : null;
          this.repoNow.set(cwd, found);
          return found;
        },
        () => null,
      );
      this.repos.set(cwd, p);
    }
    return p;
  }

  /** The current repository when already known; undefined while `pr_repo` has not answered. */
  private currentNow(): Repo | null | undefined {
    if (!this.deps.repoLookup) return NO_REPO;
    return this.repoNow.get(this.mainCwd());
  }

  private isForeign(key: PrKey): boolean {
    const cur = this.currentNow();
    return !!cur && cur !== NO_REPO && !sameRepo(cur, key);
  }

  private labelOf(key: PrKey): string {
    return this.isForeign(key) ? `${key.repo}#${key.n}` : `#${key.n}`;
  }

  private keyFrom(url: unknown, n: number | null, cur: Repo | null | undefined): PrKey | null {
    const k = parsePrUrl(url);
    if (k && (n === null || k.n === n)) return k;
    return n !== null && cur ? { host: cur.host, repo: cur.repo, n } : null;
  }

  // ---------------------------------------------------------------- registration

  private trackTrace(path: PrSource | "untrack", r: Registered | "skipped" | null, key: PrKey | null): void {
    const rec: Record<string, unknown> = { event: "pr_track", path, count: this.reg.size };
    if (r && r !== "skipped" && !r.added && "dup" in r) rec.dup = true;
    if (r === "skipped" || (r && !r.added && "skipped" in r)) rec.skipped = true;
    if (key && this.isForeign(key)) rec.foreign = true;
    this.deps.traceTrack?.(rec);
  }

  /** Register `key` for `source`; `quiet` keeps dup and skipped results out of the trace (per-tick re-attempts). */
  track(key: PrKey, source: PrSource, opts: { head?: string; quiet?: boolean } = {}): Registered {
    const r = this.reg.register(key, source, opts.head);
    if (r.added) {
      if (r.evicted) {
        this.states.delete(keyString(r.evicted));
      }
      this.trackTrace(source, r, key);
      this.wake();
    } else if (!opts.quiet) this.trackTrace(source, r, key);
    return r;
  }

  private wake(): void {
    if (this.started && !this.halted && !this.busy && !this.disposed) this.arm(0);
  }

  /** A PR number with no repository of its own: keyed on the current repository (parked until `pr_repo` answers). */
  private async trackNumber(n: number, source: PrSource): Promise<Registered | null> {
    const cur = this.currentNow() ?? (await this.repoFor(this.mainCwd()));
    if (!cur) {
      this.trackTrace(source, "skipped", null);
      return null;
    }
    return this.track({ host: cur.host, repo: cur.repo, n }, source);
  }

  /** A pr_create of this session returned PR `n` (`url` when the answer had one): track it and poll soon. */
  onCreated(n: number, url?: string): void {
    if (!validNumber(n)) return;
    const k = parsePrUrl(url);
    if (k && k.n === n) {
      this.track(k, "create");
      return;
    }
    const cur = this.currentNow();
    if (cur) this.track({ host: cur.host, repo: cur.repo, n }, "create");
    else void this.trackNumber(n, "create");
  }

  /** pr_track: track `key` under path `tool` (clears an earlier pr_untrack). */
  trackTool(key: PrKey, head?: string): Registered {
    return this.track(key, "tool", { head });
  }

  /** pr_untrack: drop the PR, its dot and its view; no automatic path adds it again. */
  untrack(key: PrKey): void {
    const id = keyString(key);
    this.reg.untrack(key);
    this.states.delete(id);
    this.closed.delete(id);
    this.order = this.order.filter((k) => keyString(k) !== id);
    this.trackTrace("untrack", null, null);
    this.publish();
  }

  /** The events feed's touched items (the shared watch snapshot): registered when of this repo or a pushed branch's repo. */
  onTouched(items: unknown): void {
    const cur = this.currentNow();
    const rs = registerTouched(this.reg, items, { current: cur && cur !== NO_REPO ? cur : null, pushed: this.pushed, now: this.now() });
    for (const r of rs) this.trackTrace("events", r, null);
    if (rs.some((r) => r.added)) this.wake();
  }

  /** Resolve the repository a pr_track/pr_untrack call means (default: the current one). */
  async resolveRepo(cwd: string, repo?: string, host?: string): Promise<Repo | null> {
    const cur = await this.repoFor(cwd);
    if (repo) return { host: host ?? cur?.host ?? "", repo };
    if (host && cur && host.toLowerCase() !== cur.host.toLowerCase()) return null;
    return cur;
  }

  /** The host rule for `host` arguments and URLs: the current repo's host, a remote's host or the host of a tracked PR. */
  async hostAllowed(host: string, cwd: string): Promise<boolean> {
    const h = host.toLowerCase();
    const cur = await this.repoFor(cwd);
    if (cur?.host && cur.host.toLowerCase() === h) return true;
    if (this.reg.hosts().includes(h)) return true;
    let p = this.remotes.get(cwd);
    if (!p) {
      p = (this.deps.remoteHosts ?? remoteHostsOf)(cwd).catch(() => []);
      this.remotes.set(cwd, p);
    }
    return (await p).includes(h);
  }

  private async scanText(text: string, cwd: string): Promise<void> {
    for (const k of scanUrls(text)) {
      if (!(await this.hostAllowed(k.host, cwd))) {
        this.trackTrace("url", "skipped", null);
        continue;
      }
      this.track(k, "url");
    }
  }

  /** The text of a PR tool result (not pr_comments) or any other scanned result: PR URLs register. */
  async onResult(text: string, cwd: string): Promise<void> {
    if (!this.deps.enabled() || this.disposed) return;
    await this.scanText(text, cwd);
  }

  private interactionPatterns(): RegExp[] {
    const src = this.deps.interactions?.();
    if (src !== this.patterns.src) this.patterns = { src, re: compilePatterns(src) };
    return this.patterns.re;
  }

  /** A foreman bash result: pushes, interactions and URLs. `ok` is exit 0. */
  async onBash(command: string, output: string, ok: boolean, cwd: string): Promise<void> {
    if (!this.deps.enabled() || this.disposed) return;
    for (const seg of chainSegments(command)) {
      if (seg.cdBad) {
        if (ok) this.trackTrace("interact", "skipped", null);
        continue;
      }
      const dir = seg.cd ? path.resolve(cwd, seg.cd) : cwd;
      if (ok) {
        const push = parsePush(seg.words);
        if (push) {
          const via = push.dirs.reduce((d, x) => path.resolve(d, x), dir);
          let branches = parsePushOutput(output);
          if (branches.length === 0 && push.dirs.length === 0 && !push.gitDir && !seg.cd) {
            const b = await (this.deps.quietBranch ?? branchWithUpstream)(cwd);
            if (b) branches = [b];
          }
          for (const name of branches) this.remember({ name, cwd: via, remote: push.remote ?? "origin" });
        }
        const hit = detectInteraction(seg) ?? matchPatterns(this.interactionPatterns(), seg.text);
        if (hit) await this.registerInteraction(hit, dir);
      }
    }
    await this.scanText(output, cwd);
  }

  /** A number-only hit is keyed by `pr_repo` run in the segment's directory (after a `cd`, or with GH_REPO the value given). */
  private async registerInteraction(hit: Interaction, dir: string): Promise<void> {
    let repo = hit.repo;
    let host = hit.host;
    if (!repo || !host) {
      const r = await this.repoFor(dir);
      if (!r) {
        this.trackTrace("interact", "skipped", null);
        return;
      }
      repo = repo ?? r.repo;
      host = host ?? r.host;
    }
    this.track({ host, repo, n: hit.n }, "interact");
  }

  private remember(p: { name: string; cwd: string; remote: string }): void {
    const have = this.pushed.find((x) => x.name === p.name && x.cwd === p.cwd);
    if (have) {
      have.at = this.now();
      return;
    }
    const rec: Pushed = { ...p, at: this.now(), repo: "", host: "", finds: 0 };
    this.pushed.unshift(rec);
    this.pushed.length = Math.min(this.pushed.length, MAX_PUSHED);
    void this.repoFor(p.cwd).then((r) => {
      if (r && r !== NO_REPO) {
        rec.repo = r.repo;
        rec.host = r.host;
      }
    });
    this.wake();
  }

  /** The pushed-branch memory (newest first). */
  pushedBranches(): readonly Pushed[] {
    return this.pushed;
  }

  // ---------------------------------------------------------------- output

  /** The tracked PRs with their state, in display order (created here, watched, then the rest by recency). */
  dots(): PrDot[] {
    return this.order.flatMap((k) => {
      const s = this.states.get(keyString(k));
      if (!s) return [];
      const d: PrDot = { n: k.n, state: this.halted ? "none" : s.state };
      if (this.isForeign(k)) d.label = this.labelOf(k).slice(0, MAX_LABEL);
      return [d];
    });
  }

  /** Full views of the tracked PRs (display order), then the merged or closed ones of the last 60 s. */
  views(): PrView[] {
    const now = this.now();
    for (const [id, v] of this.closed) if (v.closedAt !== undefined && now - v.closedAt > CLOSED_VIEW_MS) this.closed.delete(id);
    const open = this.order.flatMap((k) => {
      const v = this.states.get(keyString(k))?.view;
      return v ? [{ ...v, label: this.labelOf(k), foreign: this.isForeign(k), dot: this.halted ? ("none" as const) : v.dot }] : [];
    });
    return [...open, ...this.closed.values()];
  }

  clear(): void {
    this.disposed = true;
    this.timers.clear(this.timer);
    this.timer = null;
    this.states.clear();
    this.closed.clear();
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
    for (const k of this.order) if (!this.states.has(keyString(k))) this.states.set(keyString(k), { state: "none", fails: 0, view: null });
    this.deps.trace({ event: "pr_dots", outcome: "stopped", count: this.order.length });
    this.publish();
  }

  /** Signal the change (live file, widget) when the dots or views differ from the last published ones; trace a changed tick. */
  private publish(): void {
    const sig = this.dots().map((d) => `${d.n}:${d.state}:${d.label ?? ""}`).join(",") + "|" + this.views().map((v) => `${v.id}:${v.dot}:${v.state}:${v.title}:${v.reviewDecision}:${v.checks.counts.running}.${v.checks.counts.failed}.${v.checks.counts.missing}.${v.checks.counts.passed}`).join(",");
    if (sig === this.sig) return;
    const dotsChanged = this.sig.split("|")[0] !== sig.split("|")[0];
    this.sig = sig;
    if (dotsChanged && !this.halted) this.deps.trace({ event: "pr_dots", outcome: "tick", count: this.order.length });
    this.deps.changed?.();
  }

  private drop(key: PrKey, view?: PrView): void {
    const id = keyString(key);
    this.reg.markGone(key);
    this.states.delete(id);
    if (view) this.closed.set(id, { ...view, label: this.labelOf(key), foreign: this.isForeign(key), dot: "none", closedAt: this.now() });
    for (const [b, v] of this.branchPr) if (v && keyString(v) === id) this.branchPr.set(b, null);
  }

  /** Display order: created here (newest first), watched (as deps.watched lists them), then the rest by recency. */
  private tracked(): PrKey[] {
    const list = this.reg.list();
    const created = list.filter((e) => e.source === "create");
    const w = this.deps.watched();
    const watch = list.filter((e) => e.source === "watch").sort((a, b) => (w.indexOf(a.key.n) + 1 || 99) - (w.indexOf(b.key.n) + 1 || 99));
    const rest = list.filter((e) => e.source !== "create" && e.source !== "watch");
    return [...created, ...watch, ...rest].map((e) => e.key);
  }

  // ---------------------------------------------------------------- one tick

  private async round(): Promise<"skipped" | "ok" | "failed" | "halted"> {
    const pre = await this.deps.preflight();
    if (pre) return "skipped";
    this.tickNo += 1;
    let failed = false;
    const fresh = new Map<string, Record<string, unknown>>();
    const cwd0 = this.mainCwd();
    const cur = await this.repoFor(cwd0);
    this.currentBranch = await this.deps.branch();
    if (this.currentBranch && !this.branchPr.has(this.currentBranch)) {
      const g = classify(await this.deps.run("pr_status", {}));
      if (g.kind === "halt") return "halted";
      if (g.kind === "fail" || g.kind === "unsupported") failed = true;
      else if (g.kind === "gone") this.branchPr.set(this.currentBranch, null);
      else {
        const n = g.result.number;
        const key = typeof n === "number" && Number.isInteger(n) ? this.keyFrom(g.result.url, n, cur) : null;
        if (!key) this.branchPr.set(this.currentBranch, null);
        else {
          const open = g.result.state !== "closed" && g.result.state !== "merged";
          this.branchPr.set(this.currentBranch, open ? key : null);
          if (open) {
            fresh.set(keyString(key), g.result);
            this.track(key, "branch", { head: this.currentBranch });
          } else this.reg.markGone(key);
        }
      }
    }
    const bk = this.currentBranch ? this.branchPr.get(this.currentBranch) : null;
    for (const e of this.reg.list()) if (e.source === "branch" && (!bk || keyString(e.key) !== keyString(bk))) this.reg.remove(e.key);
    if (bk) this.track(bk, "branch", { quiet: true });
    if (this.deps.discover) {
      const d = await this.discover();
      if (d === "halted") return "halted";
      if (d === "failed") failed = true;
    }
    const w = this.deps.watched();
    if (w.length > 0 && cur) for (const n of [...w].reverse()) this.track({ host: cur.host, repo: cur.repo, n }, "watch", { quiet: true });
    this.order = this.tracked();
    const ids = new Set(this.order.map(keyString));
    for (const id of [...this.states.keys()]) if (!ids.has(id)) this.states.delete(id);
    const r = await this.pollAll(this.order, fresh);
    if (r === "halted") return "halted";
    if (this.disposed) return "ok";
    if (r === "failed") failed = true;
    this.order = this.order.filter((k) => !this.reg.isGone(k));
    return failed ? "failed" : "ok";
  }

  /** The push lookups (two per tick at most) and, every second tick, the author search. */
  private async discover(): Promise<"ok" | "failed" | "halted"> {
    let failed = false;
    const now = this.now();
    const due = this.pushed.filter((p) => p.finds === 0 || (p.finds === 1 && now - p.at >= FIND_AGAIN_MS)).slice(0, 2);
    for (const p of due) {
      p.finds += 1;
      const g = classify(await this.deps.run("pr_find", { head: p.name }, p.cwd));
      if (g.kind === "halt") return "halted";
      if (g.kind !== "ok") {
        failed = failed || g.kind === "fail";
        continue;
      }
      this.absorb(g.result, (b) => b === p.name, "push");
    }
    if (this.tickNo % 2 === 0 && (this.currentBranch || this.pushed.length > 0)) {
      const g = classify(await this.deps.run("pr_find", { author: "@me" }));
      if (g.kind === "halt") return "halted";
      if (g.kind === "fail") failed = true;
      else if (g.kind === "ok") this.absorb(g.result, (b) => b === this.currentBranch || this.pushed.some((p) => p.name === b), "search", true);
    }
    return failed ? "failed" : "ok";
  }

  /** Register (open) or remember as gone (merged, closed) the pr_find results whose head branch `want` accepts. */
  private absorb(result: Record<string, unknown>, want: (head: string) => boolean, source: PrSource, quiet = false): void {
    const prs = Array.isArray(result.prs) ? (result.prs as Record<string, unknown>[]) : [];
    const cur = this.currentNow();
    for (const pr of prs) {
      const head = typeof pr.headRefName === "string" ? pr.headRefName : "";
      if (!head || !want(head) || typeof pr.number !== "number") continue;
      const key = this.keyFrom(pr.url, pr.number, cur);
      if (!key) continue;
      if (pr.state === "merged" || pr.state === "closed") {
        this.reg.markGone(key);
        this.reg.setHead(key, head);
      } else this.track(key, source, { head, quiet });
    }
  }

  private async pollAll(keys: PrKey[], fresh: Map<string, Record<string, unknown>>): Promise<"ok" | "failed" | "halted"> {
    let failed = false;
    let rest = keys;
    if (this.deps.batch && !this.batchOff && keys.some((k) => k.repo)) {
      const r = await this.batchRound(keys);
      if (r === "halted") return r;
      if (r === "failed") failed = true;
      if (r !== "unsupported") return failed ? "failed" : "ok";
      this.batchOff = true;
      rest = keys;
    }
    for (const k of rest) {
      const r = await this.poll(k, fresh.get(keyString(k)));
      if (r === "halted") return r;
      if (this.disposed) return "ok";
      if (r === "failed") failed = true;
    }
    return failed ? "failed" : "ok";
  }

  /** One pr_batch per host. */
  private async batchRound(keys: PrKey[]): Promise<"ok" | "failed" | "halted" | "unsupported"> {
    let failed = false;
    const byHost = new Map<string, PrKey[]>();
    for (const k of keys) if (k.repo) byHost.set(k.host, [...(byHost.get(k.host) ?? []), k]);
    for (const [host, group] of byHost) {
      const g = classify(await this.deps.run("pr_batch", { ...(host ? { host } : {}), prs: group.map((k) => ({ repo: k.repo, n: k.n })) }));
      if (g.kind === "halt") return "halted";
      if (g.kind === "unsupported") return "unsupported";
      if (g.kind !== "ok") {
        for (const k of group) this.fail(keyString(k));
        failed = true;
        continue;
      }
      const prs = Array.isArray(g.result.prs) ? (g.result.prs as Record<string, unknown>[]) : [];
      const errs = Array.isArray(g.result.errors) ? (g.result.errors as Record<string, unknown>[]) : [];
      const id = (repo: unknown, n: unknown) => `${String(repo).toLowerCase()}#${String(n)}`;
      const found = new Map(prs.map((p) => [id(p.repo, p.number), p]));
      const errored = new Map(errs.map((e) => [id(e.repo, e.number), e.kind]));
      for (const k of group) {
        const p = found.get(id(k.repo, k.n));
        if (p) this.apply(k, p, p.checks as Record<string, unknown> | undefined);
        else if (errored.get(id(k.repo, k.n)) === "pr_not_found") this.drop(k);
        else {
          this.fail(keyString(k));
          failed = true;
        }
      }
    }
    return failed ? "failed" : "ok";
  }

  private viewOf(key: PrKey, st: Record<string, unknown>, checks: Record<string, unknown> | undefined): PrView {
    const id = keyString(key);
    const state = st.state === "merged" || st.state === "closed" ? st.state : "open";
    const url = typeof st.url === "string" && parsePrUrl(st.url) && sameRepo(parsePrUrl(st.url) as PrKey, key) ? st.url : null;
    const cv = checksView(checks);
    const dot = dotFromCounts(st.mergeable, cv.counts.failed, cv.counts.running + cv.counts.missing, cv.counts.passed);
    const prev = this.states.get(id)?.view;
    return {
      key,
      id,
      label: this.labelOf(key),
      foreign: this.isForeign(key),
      url,
      title: cleanText(st.title),
      state,
      draft: st.draft === true,
      mergeable: typeof st.mergeable === "string" ? cleanText(st.mergeable, 20) : null,
      reviewDecision: typeof st.reviewDecision === "string" ? cleanText(st.reviewDecision, 30) : null,
      source: this.reg.get(key)?.source ?? "branch",
      checks: cv,
      dot,
      changedAt: prev && prev.dot === dot ? prev.changedAt : this.now(),
    };
  }

  /** A status (and its checks) arrived: store the view, or drop the PR when it is merged or closed. */
  private apply(key: PrKey, st: Record<string, unknown>, checks: Record<string, unknown> | undefined): void {
    const view = this.viewOf(key, st, checks);
    const head = typeof st.headRefName === "string" ? st.headRefName : "";
    if (head) this.reg.setHead(key, head);
    if (view.state !== "open") return this.drop(key, view);
    this.states.set(view.id, { state: view.dot, fails: 0, view });
  }

  private async poll(key: PrKey, known: Record<string, unknown> | undefined): Promise<"ok" | "gone" | "failed" | "halted"> {
    const id = keyString(key);
    const where = this.isForeign(key) ? { repo: key.repo, host: key.host } : {};
    let status = known;
    if (!status) {
      const g = classify(await this.deps.run("pr_status", { number: key.n, ...where }));
      if (g.kind === "halt") return "halted";
      if (g.kind === "gone") return this.drop(key), "gone";
      if (g.kind !== "ok") return this.fail(id), "failed";
      status = g.result;
    }
    if (status.state === "closed" || status.state === "merged") return this.drop(key, this.viewOf(key, status, undefined)), "gone";
    let checks: Record<string, unknown> | undefined;
    const wc = Object.keys(where).length === 0 ? this.deps.watchChecks(key.n) : null;
    if (wc && wc.ageMs < this.baseMs()) checks = wc.checks as unknown as Record<string, unknown>;
    else {
      const g = classify(await this.deps.run("pr_checks", { number: key.n, ...where }));
      if (g.kind === "halt") return "halted";
      if (g.kind === "gone") return this.drop(key), "gone";
      if (g.kind !== "ok") return this.fail(id), "failed";
      checks = g.result;
    }
    this.apply(key, status, checks);
    return "ok";
  }

  /** A failed poll keeps the last state; the third in a row gives none. */
  private fail(id: string): void {
    const cur = this.states.get(id) ?? { state: "none" as DotState, fails: 0, view: null };
    const fails = cur.fails + 1;
    const state = fails >= MAX_FAILS ? ("none" as const) : cur.state;
    this.states.set(id, { state, fails, view: cur.view ? { ...cur.view, dot: state } : null });
  }

  // ---------------------------------------------------------------- finish and close notice

  /**
   * For each pushed branch not decided yet: skip the base branch and branches with a registered PR, else one
   * any-state pr_find, then the merged check; `notify` gets each remaining branch name once. A branch is looked
   * at most every 10 minutes; one run at a time (a second call during a run is dropped). Never throws.
   */
  async pushNotice(notify: (branch: string) => void): Promise<void> {
    if (this.noticeRunning || !this.deps.enabled()) return;
    this.noticeRunning = true;
    try {
      const base = this.deps.baseBranch?.() ?? null;
      for (const p of [...this.pushed]) {
        const id = `${p.cwd}\0${p.remote}\0${p.name}`;
        const seen = this.noticed.get(id);
        if (seen?.final || (seen && this.now() - seen.at < NOTICE_REEVAL_MS)) continue;
        this.noticed.set(id, { at: this.now(), final: false });
        const final = () => this.noticed.set(id, { at: this.now(), final: true });
        if (base && p.name === base) {
          final();
          continue;
        }
        const r = await this.repoFor(p.cwd);
        if (r && this.reg.knownHead(r.host, r.repo, p.name)) {
          final();
          continue;
        }
        const g = classify(await this.deps.run("pr_find", { head: p.name, state: "all" }, p.cwd));
        if (g.kind !== "ok") continue;
        const prs = Array.isArray(g.result.prs) ? (g.result.prs as Record<string, unknown>[]).filter((x) => x.headRefName === p.name) : [];
        if (prs.length > 0) {
          this.absorb({ prs }, (b) => b === p.name, "push");
          final();
          continue;
        }
        const merged = await this.deps.merged?.(p.cwd, p.remote, p.name);
        final();
        if (merged === false || merged === undefined) notify(p.name);
      }
    } catch {
      // display only: a failed evaluation is retried after the re-evaluation window
    } finally {
      this.noticeRunning = false;
    }
  }
}
