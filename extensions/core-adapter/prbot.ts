// Shared PR watch (docs/tools.md#shared-pr-watch): one leader session per machine holds a lease file, polls the
// PR host for review requests, failing bot PRs and the user's touched PRs, and publishes a snapshot file that
// every session reads on its PrDots tick. Followers only watch the lease and take it over when it is stale.
// Display and registration data only, never a message to the model. Timers, fs, clock and the pid probe are
// injectable. Trace records (`pr_shared`) carry an outcome, a source and a count, never a PR, repo, author or
// login; the login lives in memory only and no file holds a token or a login.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { renameRetry } from "./hints.ts";
import type { PrOp } from "./gitpack.ts";
import { parsePrUrl, validHost, validNumber, validRepo, keyString } from "./prtrack.ts";
import type { PrKey } from "./prtrack.ts";
import { realTimers } from "./prwatch.ts";
import type { Timers } from "./prwatch.ts";
import { clean } from "./prwidget.ts";
import type { PrShared, SharedItem } from "./prwidget.ts";
import type { SafeOpOutcome } from "./safeops.ts";

export const MIN_SECONDS = 60;
export const MAX_SECONDS = 3600;
export const MAX_AUTHORS = 8;
export const MAX_ITEMS = 40;
export const MAX_TOUCHED = 100;
export const MAX_BATCH = 50;
export const MAX_PAGES = 3;
export const SNAPSHOT_MAX_BYTES = 128 * 1024;
export const EMPTY_GRACE_MS = 10_000;
export const MAX_JITTER_MS = 5_000;
export const RECHECK_MS = 1_000;
export const MAX_BACKOFF_MS = 30 * 60_000;
export const TOUCHED_MAX_AGE_MS = 24 * 3600 * 1000;
export const MAX_FAILS = 3;
const MIN_TTL_S = 300;
const URL_OK = /^https:\/\/[\x21-\x7e]+$/;

export interface SharedConfig {
  enabled: boolean;
  authors: string[];
  seconds: number;
  events: boolean;
}

/** `tools.prShared` as the loader holds it (validated again here, defaults for anything missing). */
export function sharedConfig(v: unknown): SharedConfig {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const authors = Array.isArray(o.authors) ? o.authors.filter((a): a is string => typeof a === "string" && a.length > 0 && a.length <= 60).slice(0, MAX_AUTHORS) : [];
  const sec = typeof o.seconds === "number" && Number.isFinite(o.seconds) ? Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.floor(o.seconds))) : 180;
  return { enabled: o.enabled === true, authors, seconds: sec, events: o.events !== false };
}

export interface Lease {
  sessionId: string;
  pid: number;
  hostname: string;
  acquiredAt: number;
  renewedAt: number;
  expiresAt: number;
}

export interface PrBotFs {
  /** Create `p` with `data` only when absent (`wx`); false = it exists. */
  createExclusive(p: string, data: string): boolean;
  read(p: string): string | null;
  stat(p: string): { mtimeMs: number; size: number } | null;
  /** Temp file plus rename; throws when the rename fails. */
  writeAtomic(p: string, data: string): void;
  remove(p: string): void;
}

export const realFs: PrBotFs = {
  createExclusive(p, data) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let fd: number;
    try {
      fd = fs.openSync(p, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
    try {
      fs.writeSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  },
  read(p) {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  stat(p) {
    try {
      const st = fs.statSync(p);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  },
  writeAtomic(p, data) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    const res = renameRetry(tmp, p);
    if (res.error) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // gone
      }
      throw res.error;
    }
  },
  remove(p) {
    try {
      fs.unlinkSync(p);
    } catch {
      // gone
    }
  },
};

export function prBotDir(agentDir: string): string {
  return path.join(agentDir, "pi-foreman", "state", "prbot");
}

// ------------------------------------------------------------------ lease

export function parseLease(text: string | null): Lease | null {
  if (!text) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const o = v as Partial<Lease> | null;
  if (!o || typeof o !== "object") return null;
  const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  if (typeof o.sessionId !== "string" || !o.sessionId || !num(o.pid) || !Number.isInteger(o.pid) || o.pid < 1 || typeof o.hostname !== "string" || !num(o.acquiredAt) || !num(o.renewedAt) || !num(o.expiresAt)) return null;
  return { sessionId: o.sessionId, pid: o.pid, hostname: o.hostname, acquiredAt: o.acquiredAt, renewedAt: o.renewedAt, expiresAt: o.expiresAt };
}

// ------------------------------------------------------------------ snapshot

const SRC_NOTIF = new Set(["ok", "fallback", "off"]);
const SRC_EVENTS = new Set(["ok", "off"]);

function readItem(v: unknown): SharedItem | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || !validHost(o.host) || !validRepo(o.repo) || !validNumber(o.n)) return null;
  const url = typeof o.url === "string" && o.url.length <= 1024 && URL_OK.test(o.url) ? o.url : null;
  return { host: o.host, repo: o.repo, n: o.n, title: clean(o.title), url };
}

/** The snapshot file text as display data, or null (too big, unparseable or the wrong shape). Bad items are dropped. */
export function parseSnapshot(text: string | null): PrShared | null {
  if (!text || text.length > SNAPSHOT_MAX_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  if (typeof o.at !== "number" || !Number.isFinite(o.at) || o.at <= 0) return null;
  if (typeof o.intervalSeconds !== "number" || !Number.isFinite(o.intervalSeconds) || o.intervalSeconds < 1 || o.intervalSeconds > 86_400) return null;
  if (typeof o.degraded !== "boolean" || !Array.isArray(o.review) || !Array.isArray(o.failing) || !Array.isArray(o.touched)) return null;
  const items = (list: unknown[]) => list.slice(0, MAX_ITEMS).flatMap((i) => readItem(i) ?? []);
  const touched: PrShared["touched"] = [];
  for (const t of o.touched.slice(0, MAX_TOUCHED)) {
    const it = readItem(t);
    const at = (t as { at?: unknown } | null)?.at;
    if (it && typeof at === "number" && Number.isFinite(at)) touched.push({ host: it.host, repo: it.repo, n: it.n, url: it.url, at });
  }
  const s = o.sources as Record<string, unknown> | null | undefined;
  const sources: NonNullable<PrShared["sources"]> = {};
  if (s && typeof s === "object") {
    if (typeof s.notifications === "string" && SRC_NOTIF.has(s.notifications)) sources.notifications = s.notifications;
    if (typeof s.events === "string" && SRC_EVENTS.has(s.events)) sources.events = s.events;
  }
  return { at: o.at, intervalSeconds: o.intervalSeconds, degraded: o.degraded, sources, review: items(o.review), failing: items(o.failing), touched };
}

/** The doctor lines: the watch line, then a WARN for each config warning about a project or session `tools.prShared`. */
export function sharedDoctorLines(line: string, warnings: readonly string[]): string[] {
  return [`INFO ${line}`, ...warnings.filter((w) => w.includes("tools.prShared")).map((w) => `WARN pr shared watch: ${w}`)];
}

// ------------------------------------------------------------------ the bot

export interface PrBotDeps {
  /** Foreman session with the PR tools on (never a child). */
  active(): boolean;
  /** `tools.prShared` as merged. */
  config(): unknown;
  /** `tools.prHost`: an object means templates. */
  prHost(): unknown;
  /** `<agentDir>/pi-foreman/state/prbot` */
  dir: string;
  sessionId: string;
  /** A PR op in `cwd` (30 s timeout). */
  run(op: PrOp, args: Record<string, unknown>, cwd: string): Promise<SafeOpOutcome>;
  cwd(): string;
  /** The drift preflight in print mode; a block skips the tick. */
  preflight?(): Promise<{ block: true; reason: string } | undefined>;
  trace(rec: Record<string, unknown>): void;
  timers?: Timers;
  now?(): number;
  random?(): number;
  fs?: PrBotFs;
  pid?: number;
  hostname?: string;
  /** `process.kill(pid, 0)`: throws with `code` ESRCH (dead) or EPERM (alive). */
  kill?(pid: number): void;
}

type Role = "idle" | "leader" | "follower" | "stopped";
type SrcName = "notifications" | "search" | "events";
type Got = { k: "ok"; r: Record<string, unknown> } | { k: "halt" } | { k: "unsupported" } | { k: "fail"; rate: boolean; message: string };
type Out = { k: "ok"; count: number } | { k: "unchanged" } | { k: "off" } | { k: "halt" } | { k: "fail"; rate: boolean };

interface Src {
  timer: unknown;
  level: number;
  fails: number;
  degraded: boolean;
  pollS: number;
}

const RATE_RE = /rate[ _-]?limit|\b403\b|\b429\b/i;
const itemOrder = (a: SharedItem, b: SharedItem): number => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.n - b.n);
const keyOf = (i: { host: string; repo: string; n: number }): string => keyString(i);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export class PrBot {
  private readonly deps: PrBotDeps;
  private readonly timers: Timers;
  private readonly fs: PrBotFs;
  private role: Role = "idle";
  private disposed = false;
  private term = 0;
  private cfg: SharedConfig = sharedConfig(undefined);
  private leaseTimer: unknown = null;
  private sleeps = new Set<unknown>();
  private src: Record<SrcName, Src> = { notifications: this.newSrc(), search: this.newSrc(), events: this.newSrc() };
  // leader memory (a new leader starts unconditionally)
  private lastMod: string | null = null;
  private etag: string | null = null;
  private login: string | null = null;
  private fallback = false;
  private notifOff = false;
  private eventsOff = false;
  private hostOff = false;
  private review: SharedItem[] = [];
  private failing: SharedItem[] = [];
  private touched: Map<string, { item: SharedItem; at: number }> = new Map();
  private lastSig = "";
  private lastWrite = 0;
  // reader
  private readStamp = "";
  private readCache: PrShared | null = null;

  constructor(deps: PrBotDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? realTimers;
    this.fs = deps.fs ?? realFs;
  }

  private newSrc(): Src {
    return { timer: null, level: 0, fails: 0, degraded: false, pollS: 0 };
  }
  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
  private leasePath(): string {
    return path.join(this.deps.dir, "lease.json");
  }
  private snapPath(): string {
    return path.join(this.deps.dir, "snapshot.json");
  }
  private t(outcome: string, source?: string, count?: number): void {
    this.deps.trace({ event: "pr_shared", outcome, ...(source ? { source } : {}), ...(count !== undefined ? { count } : {}) });
  }
  private ttlMs(): number {
    return Math.max(MIN_TTL_S, 3 * this.cfg.seconds) * 1000;
  }
  private sleep(ms: number): Promise<void> {
    return new Promise((res) => {
      const h = this.timers.set(() => {
        this.sleeps.delete(h);
        res();
      }, ms);
      this.sleeps.add(h);
    });
  }

  // ---------------------------------------------------------------- lifecycle

  /** Begin: the first lease round runs now. Nothing happens when the watch is off or this is a child. */
  start(): void {
    if (this.role !== "idle" || this.disposed || !this.deps.active()) return;
    this.cfg = sharedConfig(this.deps.config());
    if (!this.cfg.enabled) return;
    this.role = "follower";
    this.armLease(0);
  }

  /** Session shutdown: stop every timer and release the lease when we hold it. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release();
    this.clearAll();
  }

  /** `off`, or `on (leader|follower; notifications ok|fallback|off, events ok|off, <n> authors)`. */
  describe(): string {
    if (this.role === "idle") return "pr shared watch: off";
    const n = this.cfg.authors.length;
    let notif: string;
    let events: string;
    if (this.role === "leader") {
      notif = this.notifState();
      events = this.eventsState();
    } else {
      const sh = this.read();
      notif = sh?.sources?.notifications ?? "off";
      events = sh?.sources?.events ?? "off";
    }
    const role = this.role === "stopped" ? "stopped (host CLI missing or not logged in)" : this.role;
    const note = this.isTemplate() || this.hostOff ? "; failing group needs gh" : "";
    return `pr shared watch: on (${role}; notifications ${notif}, events ${events}, ${n} author${n === 1 ? "" : "s"}${note})`;
  }

  private notifState(): "ok" | "fallback" | "off" {
    return this.notifOff || this.hostOff || this.isTemplate() ? "off" : this.fallback ? "fallback" : "ok";
  }
  private eventsState(): "ok" | "off" {
    return this.eventsOff || this.hostOff || this.isTemplate() || !this.cfg.events ? "off" : "ok";
  }
  private isTemplate(): boolean {
    const h = this.deps.prHost();
    return !!h && typeof h === "object";
  }

  private clearAll(): void {
    this.timers.clear(this.leaseTimer);
    this.leaseTimer = null;
    for (const h of this.sleeps) this.timers.clear(h);
    this.sleeps.clear();
    this.stopSources();
  }

  private stopSources(): void {
    this.term += 1;
    for (const s of Object.values(this.src)) {
      this.timers.clear(s.timer);
      s.timer = null;
    }
  }

  // ---------------------------------------------------------------- lease

  private armLease(ms: number): void {
    this.timers.clear(this.leaseTimer);
    this.leaseTimer = this.timers.set(() => void this.leaseTick(), ms);
  }

  private async leaseTick(): Promise<void> {
    this.leaseTimer = null;
    if (this.disposed || this.role === "stopped" || this.role === "idle") return;
    try {
      this.cfg = sharedConfig(this.deps.config());
      if (!this.cfg.enabled || !this.deps.active()) {
        this.release();
        this.role = "idle";
        this.stopSources();
        return;
      }
      if (this.role === "leader") this.renew();
      else await this.elect();
    } catch {
      this.t("error", "lease");
    }
    if (this.participating()) this.armLease(this.cfg.seconds * 1000);
  }

  /** Still in the lease race (the role can change across the awaits above). */
  private participating(): boolean {
    const r: Role = this.role;
    return !this.disposed && (r === "leader" || r === "follower");
  }

  private mine(prev?: Lease): Lease {
    const now = this.now();
    return { sessionId: this.deps.sessionId, pid: this.deps.pid ?? process.pid, hostname: this.deps.hostname ?? os.hostname(), acquiredAt: prev?.acquiredAt ?? now, renewedAt: now, expiresAt: now + this.ttlMs() };
  }

  private pidState(pid: number): "alive" | "dead" {
    try {
      (this.deps.kill ?? ((p: number) => void process.kill(p, 0)))(pid);
      return "alive";
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "alive";
    }
  }

  /** "absent", "ok" (a live lease), or "stale" (expired, dead pid on this host, or unreadable past the grace). */
  private inspect(): { state: "absent" } | { state: "stale" } | { state: "ok"; lease: Lease } {
    const st = this.fs.stat(this.leasePath());
    if (!st) return { state: "absent" };
    const lease = parseLease(this.fs.read(this.leasePath()));
    if (!lease) return this.now() - st.mtimeMs > EMPTY_GRACE_MS ? { state: "stale" } : { state: "ok", lease: { sessionId: "", pid: 1, hostname: "", acquiredAt: 0, renewedAt: 0, expiresAt: 0 } };
    if (lease.sessionId === this.deps.sessionId) return { state: "ok", lease };
    if (this.now() >= lease.expiresAt) return { state: "stale" };
    if (lease.hostname === (this.deps.hostname ?? os.hostname()) && this.pidState(lease.pid) === "dead") return { state: "stale" };
    return { state: "ok", lease };
  }

  private async elect(): Promise<void> {
    const seen = this.inspect();
    if (seen.state === "absent") {
      if (this.fs.createExclusive(this.leasePath(), JSON.stringify(this.mine()))) return this.becomeLeader("lease_acquired");
      return;
    }
    if (seen.state === "ok") {
      if (seen.lease.sessionId === this.deps.sessionId) return this.becomeLeader("lease_acquired");
      return;
    }
    // Stale: jitter, re-read, write, re-read after a second; keep it only with our session id.
    await this.sleep(Math.floor((this.deps.random ?? Math.random)() * MAX_JITTER_MS));
    if (this.disposed || this.role !== "follower") return;
    const again = this.inspect();
    if (again.state === "ok") return;
    if (again.state === "absent") {
      if (this.fs.createExclusive(this.leasePath(), JSON.stringify(this.mine()))) return this.becomeLeader("lease_acquired");
      return;
    }
    this.fs.writeAtomic(this.leasePath(), JSON.stringify(this.mine()));
    await this.sleep(RECHECK_MS);
    if (this.disposed || this.role !== "follower") return;
    const after = parseLease(this.fs.read(this.leasePath()));
    if (after?.sessionId === this.deps.sessionId) this.becomeLeader("lease_acquired");
  }

  private renew(): void {
    const cur = parseLease(this.fs.read(this.leasePath()));
    if (!cur || cur.sessionId !== this.deps.sessionId) return this.stepDown();
    this.fs.writeAtomic(this.leasePath(), JSON.stringify(this.mine(cur)));
    this.t("lease_renewed");
  }

  private stepDown(): void {
    this.role = "follower";
    this.stopSources();
    this.resetMemory();
    this.t("lease_lost");
  }

  private resetMemory(): void {
    this.lastMod = null;
    this.etag = null;
    this.login = null;
    this.fallback = false;
    this.notifOff = false;
    this.eventsOff = false;
    this.hostOff = false;
    this.review = [];
    this.failing = [];
    this.touched = new Map();
    this.lastSig = "";
    this.src = { notifications: this.newSrc(), search: this.newSrc(), events: this.newSrc() };
  }

  private release(): void {
    if (this.role !== "leader") return;
    const cur = parseLease(this.fs.read(this.leasePath()));
    if (cur?.sessionId === this.deps.sessionId) {
      this.fs.remove(this.leasePath());
      this.t("released");
    }
    this.role = "follower";
  }

  private becomeLeader(outcome: string): void {
    this.resetMemory();
    this.role = "leader";
    this.t(outcome);
    const term = this.term;
    this.armSrc("search", 0, term);
    if (this.isTemplate()) return;
    this.armSrc("notifications", 0, term);
    if (this.cfg.events) this.armSrc("events", 0, term);
  }

  private halt(): void {
    this.t("stopped");
    this.release();
    this.role = "stopped";
    this.clearAll();
  }

  // ---------------------------------------------------------------- sources

  private armSrc(name: SrcName, ms: number, term: number): void {
    const s = this.src[name];
    this.timers.clear(s.timer);
    s.timer = this.timers.set(() => void this.srcTick(name, term), ms);
  }

  private delayMs(s: Src): number {
    const base = Math.max(this.cfg.seconds * 1000, s.pollS * 1000);
    return Math.max(base, Math.min(base * 2 ** s.level, MAX_BACKOFF_MS));
  }

  private async srcTick(name: SrcName, term: number): Promise<void> {
    const s = this.src[name];
    s.timer = null;
    if (term !== this.term || this.role !== "leader" || this.disposed) return;
    let out: Out;
    try {
      const pre = await this.deps.preflight?.();
      if (pre) out = { k: "unchanged" };
      else out = name === "notifications" ? await this.notifTick(term) : name === "events" ? await this.eventsTick(term) : await this.searchTick(term);
    } catch {
      out = { k: "fail", rate: false };
    }
    if (term !== this.term || this.role !== "leader" || this.disposed) return;
    if (out.k === "halt") return this.halt();
    if (out.k === "off") {
      this.publish();
      return;
    }
    if (out.k === "fail") {
      s.fails += 1;
      const before = this.delayMs(s);
      if (out.rate || s.fails >= MAX_FAILS) {
        s.level += 1;
        s.degraded = true;
      }
      this.t("error", name);
      if (this.delayMs(s) > before) this.t("backoff", name);
    } else {
      s.fails = 0;
      s.level = 0;
      s.degraded = false;
      this.t(out.k === "ok" ? "tick" : "unchanged", name, out.k === "ok" ? out.count : undefined);
    }
    this.publish();
    this.armSrc(name, this.delayMs(s), term);
  }

  private async call(op: PrOp, args: Record<string, unknown>): Promise<Got> {
    const o = await this.deps.run(op, args, this.deps.cwd());
    if (o.kind === "ran") return { k: "ok", r: o.result };
    if (o.kind === "precondition") {
      if (o.precondition === "pr_auth_missing" || o.precondition === "pr_host_missing") return { k: "halt" };
      if (o.precondition === "pr_unsupported") return { k: "unsupported" };
    }
    const message = str(o.message).split("\n")[0];
    return { k: "fail", rate: RATE_RE.test(message), message };
  }

  private setPoll(name: SrcName, v: unknown): void {
    this.src[name].pollS = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  }

  /** The host CLI cannot do the built-in sources (glab): no notifications, events or failing group. */
  private unsupportedHost(): Out {
    this.hostOff = true;
    this.review = [];
    this.failing = [];
    this.touched = new Map();
    this.stopSources();
    this.publish();
    return { k: "off" };
  }

  /** The item of a host answer: identity and link from its URL, nothing else trusted. */
  private toItem(url: unknown, title: unknown): SharedItem | null {
    const key: PrKey | null = parsePrUrl(url);
    return key && typeof url === "string" && url.length <= 1024 && URL_OK.test(url) ? { host: key.host, repo: key.repo, n: key.n, title: clean(title), url } : null;
  }

  private itemsOf(list: unknown): SharedItem[] {
    const out = new Map<string, SharedItem>();
    for (const e of Array.isArray(list) ? list : []) {
      const o = e as Record<string, unknown> | null;
      const it = o && typeof o === "object" ? this.toItem(o.url, o.title) : null;
      if (it && !out.has(keyOf(it))) out.set(keyOf(it), it);
    }
    return [...out.values()];
  }

  /** One pr_batch per host over `items` (at most 50 each). */
  private async batch(items: SharedItem[]): Promise<{ k: "ok"; prs: Map<string, Record<string, unknown>>; gone: Set<string> } | { k: "out"; out: Out }> {
    const byHost = new Map<string, SharedItem[]>();
    for (const i of items) byHost.set(i.host, [...(byHost.get(i.host) ?? []), i]);
    const prs = new Map<string, Record<string, unknown>>();
    const gone = new Set<string>();
    for (const [host, list] of byHost) {
      const g = await this.call("pr_batch", { host, prs: list.slice(0, MAX_BATCH).map((i) => ({ repo: i.repo, n: i.n })) });
      if (g.k === "halt") return { k: "out", out: { k: "halt" } };
      if (g.k === "unsupported") return { k: "out", out: { k: "fail", rate: false } };
      if (g.k === "fail") return { k: "out", out: { k: "fail", rate: g.rate } };
      for (const p of Array.isArray(g.r.prs) ? g.r.prs : []) {
        const o = p as Record<string, unknown>;
        if (typeof o.repo === "string" && typeof o.number === "number") prs.set(keyString({ host, repo: o.repo, n: o.number }), o);
      }
      for (const e of Array.isArray(g.r.errors) ? g.r.errors : []) {
        const o = e as Record<string, unknown>;
        if (o.kind === "pr_not_found" && typeof o.repo === "string" && typeof o.number === "number") gone.add(keyString({ host, repo: o.repo, n: o.number }));
      }
    }
    return { k: "ok", prs, gone };
  }

  private setList(which: "review" | "failing", next: SharedItem[]): boolean {
    const cur = this[which];
    const same = cur.length === next.length && cur.every((c, i) => keyOf(c) === keyOf(next[i]) && c.title === next[i].title);
    this[which] = next;
    return !same;
  }

  private async notifTick(term: number): Promise<Out> {
    if (this.fallback) return this.reviewSearch();
    const first = await this.call("pr_poll", { endpoint: "notifications", page: 1, ...(this.lastMod ? { since: this.lastMod } : {}) });
    if (first.k === "halt") return { k: "halt" };
    if (first.k === "unsupported") return this.unsupportedHost();
    if (first.k === "fail") return { k: "fail", rate: first.rate };
    const r = first.r;
    this.setPoll("notifications", r.pollInterval);
    if (r.status === 304) return { k: "unchanged" };
    if (r.status === 403 || r.status === 404) {
      this.fallback = true;
      this.lastMod = null;
      this.t("notifications_fallback", "notifications");
      return this.reviewSearch();
    }
    if (r.status === 429) return { k: "fail", rate: true };
    if (r.status !== 200 || !Array.isArray(r.items)) return { k: "fail", rate: false };
    const raw: unknown[] = [...r.items];
    for (let page = 2; page <= MAX_PAGES; page++) {
      const g = await this.call("pr_poll", { endpoint: "notifications", page });
      if (g.k === "halt") return { k: "halt" };
      if (g.k !== "ok" || g.r.status !== 200 || !Array.isArray(g.r.items)) break;
      raw.push(...g.r.items);
    }
    if (term !== this.term) return { k: "unchanged" };
    const cand = this.itemsOf(raw);
    const b = await this.batch(cand);
    if (b.k === "out") return b.out;
    const kept: SharedItem[] = [];
    for (const i of cand) {
      const id = keyOf(i);
      if (b.gone.has(id)) continue;
      const p = b.prs.get(id);
      if (p && p.state !== "open") continue;
      kept.push(p && typeof p.title === "string" && p.title ? { ...i, title: clean(p.title) } : i);
    }
    this.lastMod = typeof r.lastModified === "string" && r.lastModified ? r.lastModified : this.lastMod;
    this.setList("review", kept);
    return { k: "ok", count: kept.length };
  }

  private async reviewSearch(): Promise<Out> {
    const g = await this.call("pr_search", { reviewRequested: true });
    if (g.k === "halt") return { k: "halt" };
    if (g.k === "unsupported") return { k: "fail", rate: false };
    if (g.k === "fail") return { k: "fail", rate: g.rate };
    const items = this.itemsOf(g.r.prs);
    this.setList("review", items);
    return { k: "ok", count: items.length };
  }

  private async searchTick(term: number): Promise<Out> {
    const authors = this.cfg.authors;
    const template = this.isTemplate();
    const found = new Map<string, SharedItem & { rr: boolean }>();
    for (const author of authors) {
      const g = await this.call("pr_search", { author });
      if (g.k === "halt") return { k: "halt" };
      if (g.k === "unsupported") return this.unsupportedHost();
      if (g.k === "fail") return { k: "fail", rate: g.rate };
      for (const e of Array.isArray(g.r.prs) ? g.r.prs : []) {
        const o = e as Record<string, unknown>;
        const it = o && typeof o === "object" ? this.toItem(o.url, o.title) : null;
        if (it && !found.has(keyOf(it))) found.set(keyOf(it), { ...it, rr: o.reviewRequested === true });
      }
    }
    if (term !== this.term) return { k: "unchanged" };
    const all = [...found.values()];
    if (template) {
      const rr = all.filter((i) => i.rr).map(({ rr: _rr, ...i }) => i);
      this.setList("review", rr);
      return { k: "ok", count: rr.length };
    }
    const union = all.slice(0, MAX_BATCH).map(({ rr: _rr, ...i }) => i);
    let failing: SharedItem[] = [];
    if (union.length > 0) {
      const b = await this.batch(union);
      if (b.k === "out") return b.out;
      failing = union.flatMap((i) => {
        const p = b.prs.get(keyOf(i));
        const checks = p?.checks as { failed?: unknown[]; counts?: { failed?: unknown } } | undefined;
        const nFailed = typeof checks?.counts?.failed === "number" ? checks.counts.failed : Array.isArray(checks?.failed) ? checks.failed.length : 0;
        return p && p.state === "open" && nFailed > 0 ? [typeof p.title === "string" && p.title ? { ...i, title: clean(p.title) } : i] : [];
      });
    }
    this.setList("failing", failing);
    return { k: "ok", count: failing.length };
  }

  private async eventsTick(term: number): Promise<Out> {
    if (!this.login) {
      const g = await this.call("pr_login", {});
      if (g.k === "halt") return { k: "halt" };
      if (g.k === "unsupported") return this.unsupportedHost();
      if (g.k === "fail") return { k: "fail", rate: g.rate };
      if (typeof g.r.login !== "string" || !g.r.login) return { k: "fail", rate: false };
      this.login = g.r.login;
    }
    const g = await this.call("pr_poll", { endpoint: "events", login: this.login, ...(this.etag ? { etag: this.etag } : {}) });
    if (g.k === "halt") return { k: "halt" };
    if (g.k === "unsupported") return this.unsupportedHost();
    if (g.k === "fail") return { k: "fail", rate: g.rate };
    const r = g.r;
    this.setPoll("events", r.pollInterval);
    if (r.status === 403 || r.status === 404) {
      this.eventsOff = true;
      this.touched = new Map();
      this.t("events_unavailable", "events");
      return { k: "off" };
    }
    if (r.status === 429) return { k: "fail", rate: true };
    const before = this.touched.size;
    if (r.status === 304) {
      this.ageTouched();
      return this.touched.size === before ? { k: "unchanged" } : { k: "ok", count: this.touched.size };
    }
    if (r.status !== 200 || !Array.isArray(r.items)) return { k: "fail", rate: false };
    if (typeof r.etag === "string" && r.etag) this.etag = r.etag;
    for (const e of r.items) {
      const o = e as Record<string, unknown> | null;
      const at = Date.parse(str(o?.at));
      const it = o && typeof o === "object" ? this.toItem(o.url, "") : null;
      if (!it || !Number.isFinite(at) || this.now() - at > TOUCHED_MAX_AGE_MS) continue;
      const id = keyOf(it);
      const prev = this.touched.get(id);
      if (!prev || prev.at < at) this.touched.set(id, { item: it, at });
    }
    this.ageTouched();
    return { k: "ok", count: this.touched.size };
  }

  private ageTouched(): void {
    const keep = [...this.touched.entries()].filter(([, v]) => this.now() - v.at <= TOUCHED_MAX_AGE_MS).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_TOUCHED);
    this.touched = new Map(keep);
  }

  // ---------------------------------------------------------------- snapshot

  private build(): Record<string, unknown> {
    this.ageTouched();
    const failIds = new Set(this.failing.map(keyOf));
    const failing = [...this.failing].sort(itemOrder);
    const review = this.review.filter((i) => !failIds.has(keyOf(i))).sort(itemOrder);
    const lists = [...failing, ...review].slice(0, MAX_ITEMS);
    const fail = lists.slice(0, failing.length);
    const rev = lists.slice(failing.length);
    const row = (i: SharedItem) => ({ host: i.host, repo: i.repo, n: i.n, title: i.title, url: i.url });
    return {
      leader: this.deps.sessionId,
      intervalSeconds: this.cfg.seconds,
      degraded: Object.values(this.src).some((s) => s.degraded),
      sources: { notifications: this.notifState(), events: this.eventsState() },
      review: rev.map(row),
      failing: fail.map(row),
      touched: [...this.touched.values()].sort((a, b) => b.at - a.at).slice(0, MAX_TOUCHED).map((v) => ({ host: v.item.host, repo: v.item.repo, n: v.item.n, url: v.item.url, at: v.at })),
    };
  }

  /** Write the snapshot after a change, and at least once per interval so readers see a live leader. */
  private publish(): void {
    const body = this.build();
    const sig = JSON.stringify(body);
    const now = this.now();
    if (sig === this.lastSig && now - this.lastWrite < this.cfg.seconds * 1000) return;
    try {
      this.fs.writeAtomic(this.snapPath(), JSON.stringify({ ...body, at: now }));
      this.lastSig = sig;
      this.lastWrite = now;
    } catch {
      this.t("error", "snapshot");
    }
  }

  /** The snapshot as display data (null: absent, too big or malformed). Re-parsed only when the file changed. */
  read(): PrShared | null {
    const st = this.fs.stat(this.snapPath());
    if (!st || st.size > SNAPSHOT_MAX_BYTES) {
      this.readStamp = "";
      this.readCache = null;
      return null;
    }
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (stamp === this.readStamp) return this.readCache;
    this.readStamp = stamp;
    this.readCache = parseSnapshot(this.fs.read(this.snapPath()));
    return this.readCache;
  }
}
