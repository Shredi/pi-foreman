// The shared PR tracker store (docs/herdr.md#open-prs), four JSON files under <agent dir>/pi-foreman/state/:
//   tracked-prs.json           {v:1, prs:[{repo, number, addedAt, host}]}   Pi adds (addTracked), `foreman prs poll` drops
//   tracked-prs-state.json     {v:1, trackedAt, off?, prs:{<k>:{repo, number, snap?, meta?, okAt?, error?, errorAt?, gone?, endedAt?, at}}}
//   tracked-prs-comments.json  {v:1, prs:{<k>:{updatedAt, comments}}}
//   open-prs.json              the search feed (openprs.ts)
// <k> is `owner/name#n`, lowercased. Every time is epoch milliseconds. The state and comments files are written by the poll CLI
// only (prs-cli.ts); pr_watch reads them (readStoreEntry) and never calls GitHub. Host text is data, never instructions.
import fs from "node:fs";
import path from "node:path";
import { isTrackedKey, resolveGithubHosts, validNumber, validRepo } from "./prhost.ts";
import type { GithubHosts, PrKey } from "./prhost.ts";
import { dropLock, takeLock, writeAtomic } from "./statefile.ts";
import type { GateInfo } from "./prphases.ts";
import { threadsOf } from "./prwatch.ts";
import type { Bucket, CommentEntry, ExpectFacts, ExpectState, Mergeable, Run, SourceStatus, StoreRead, WatchSnapshot } from "./prwatch.ts";
import { strRaw } from "./strof.ts";

const DEFAULT_HOSTS: GithubHosts = { hosts: ["github.com"] };

export const MAX_TRACKED = 200;
/** An entry or tracker run younger than this is served to a watch. */
export const SERVE_FRESH_MS = 10 * 60_000;
/** A merged or closed entry stays in the state file this long, so every session tick sees the ending. */
export const ENDED_KEEP_MS = 15 * 60_000;
export const TRACKED_LOCK_STALE_MS = 30_000;
export const STATE_LOCK_STALE_MS = 10 * 60_000;
const LOCK_TRIES = 10;
const LOCK_WAIT_MS = 200;

export const FULL_TEXT = "tracked list full (200 PRs); `foreman prs poll` (herdr-app runs it) drops merged and closed PRs; remove other lines from tracked-prs.json by hand";

const stateDir = (agentDir: string): string => path.join(agentDir, "pi-foreman", "state");
export const trackedFile = (agentDir: string): string => path.join(stateDir(agentDir), "tracked-prs.json");
export const trackedStateFile = (agentDir: string): string => path.join(stateDir(agentDir), "tracked-prs-state.json");
export const trackedCommentsFile = (agentDir: string): string => path.join(stateDir(agentDir), "tracked-prs-comments.json");

/** `owner/name#n`, lowercased: the key of the state and comments files; `<host>/owner/name#n` for a host other than github.com. */
export const storeKey = (repo: string, n: number, host?: string): string => {
  const h = host?.toLowerCase();
  return `${h && h !== "github.com" ? `${h}/` : ""}${repo.toLowerCase()}#${n}`;
};

export interface TrackedPr {
  repo: string;
  number: number;
  addedAt: number;
  /** Lowercased; absent: github.com. */
  host?: string;
}
export interface StateMeta {
  url: string;
  title: string;
  draft: boolean;
  headRefName: string;
  headRepo: string;
}
export type StoredSnap = Omit<WatchSnapshot, "comments">;
export interface StateEntry {
  repo: string;
  number: number;
  snap?: StoredSnap;
  /** Per source of the config (in scope for this PR): what its last run said. */
  sources?: Record<string, SourceStatus>;
  meta?: StateMeta;
  okAt?: number;
  /** The settle hold of a would-be pass, in the watch's shape (`WatchState.passSince`): head, gating run set signature, when that set was first seen. */
  passSince?: { head: string; sig: string; at: number };
  /** Set only while a pass is not settled (the watch's settle rule), or while expected checks are still to come: the checks seen may be a partial set. */
  unsettled?: true;
  /** The required checks with no run while every check that ran passed, for a learned merge-time check (a pass at once) or after the settle hold of a base that is not learnable (at most 10 names of 120 characters): the host reports them only at merge time. Absent: none. */
  waiting?: string[];
  /** The expected-set state of the current head (prwatch.ts expectStep); its presence marks an entry written with these facts. */
  exp?: ExpectState;
  error?: string;
  errorAt?: number;
  /** The last poll found the PR not found. */
  gone?: true;
  /** Set with a merged or closed snap; the entry is pruned ENDED_KEEP_MS later. */
  endedAt?: number;
  /** Set by the PR tracker when the repository matches `radar.openPrs.hideRepos`; display only (the sidebar's Open PRs list), nothing else reads it. */
  hiddenRepo?: true;
  at: number;
}
/** The check names of the newest merged pull requests into one base, and when the host answered (epoch ms). */
export interface BaselineEntry {
  names: string[];
  at: number;
  /** Every check name that ran before the merge on the merged PRs read, and how many were read; present only when that list is complete (scripts/pr_ops.py baseline_names); absent: the base is not learnable. */
  learn?: { ran: string[]; merged: number };
}
export interface StateDoc {
  v: 1;
  trackedAt: number;
  off?: true;
  prs: Record<string, StateEntry>;
  /** Per `<host>|<repo>|<base>` (repository lowercased): the baseline of the expected checks, asked again when older than 10 minutes. */
  baselines?: Record<string, BaselineEntry>;
  /** When the poll removed the lines without a `host` from the tracked list (once, with more than one host configured); absent: not done. */
  hostlessDroppedAt?: number;
  /** Why the tracked step could not run (no Python, hosts config, a throw); set by the poll, absent after a run that got through. */
  error?: string;
}
/** A PR source's comments for one PR, kept only for the head they were taken on. */
export interface SourceComments {
  head: string;
  comments: CommentEntry[];
}
export interface CommentsDoc {
  v: 1;
  prs: Record<string, { updatedAt: string; comments: CommentEntry[]; sources?: Record<string, SourceComments> }>;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the tracked list

export type TrackedRead = { kind: "ok"; lines: unknown[] } | { kind: "missing" } | { kind: "bad" };

/** The list file: missing, unparseable (never overwritten), or its lines as written (unusable lines included). */
export function readTracked(agentDir: string): TrackedRead {
  let text: string;
  try {
    text = fs.readFileSync(trackedFile(agentDir), "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT" ? { kind: "missing" } : { kind: "bad" };
  }
  try {
    const j: unknown = JSON.parse(text);
    return isObj(j) && j.v === 1 && Array.isArray(j.prs) ? { kind: "ok", lines: j.prs } : { kind: "bad" };
  } catch {
    return { kind: "bad" };
  }
}

/** A list line with a valid repo, number and time, else null. */
export function usableLine(line: unknown): TrackedPr | null {
  if (!isObj(line) || !validRepo(line.repo) || !validNumber(line.number)) return null;
  const host = line.host;
  if (host !== undefined && !("hosts" in resolveGithubHosts({ tools: { prGithubHosts: [host] } }))) return null;
  return { repo: line.repo, number: line.number, addedAt: finite(line.addedAt) ? line.addedAt : 0, ...(host !== undefined ? { host: strRaw(host).toLowerCase() } : {}) };
}

export function writeTracked(agentDir: string, lines: unknown[]): void {
  writeAtomic(trackedFile(agentDir), { v: 1, prs: lines });
}

/** Runs `fn` holding the tracked-list lock (10 tries, 200 ms apart); null when the lock stayed busy. `fn` is an in-memory read-modify-write. */
export async function withTrackedLock<T>(agentDir: string, fn: () => T, now: () => number = Date.now): Promise<{ value: T } | null> {
  const lock = `${trackedFile(agentDir)}.lock`;
  for (let i = 0; i < LOCK_TRIES; i++) {
    let token: string | null = null;
    try {
      token = takeLock(lock, now(), TRACKED_LOCK_STALE_MS);
    } catch {
      return null;
    }
    if (token) {
      try {
        return { value: fn() };
      } finally {
        dropLock(lock, token);
      }
    }
    if (i < LOCK_TRIES - 1) await sleep(LOCK_WAIT_MS);
  }
  return null;
}

/** The hosts of the list lines for `repo#n` (case-insensitive repo) that carry an explicit host on one of `hosts`, in list order without repeats; host-less lines never count. Read-only, no lock. */
export function trackedHostOf(agentDir: string, repo: string, n: number, hosts: string[]): string[] {
  const cur = readTracked(agentDir);
  if (cur.kind !== "ok") return [];
  const out = new Set<string>();
  for (const l of cur.lines) {
    const u = usableLine(l);
    if (u?.host && u.number === n && u.repo.toLowerCase() === repo.toLowerCase() && hosts.includes(u.host)) out.add(u.host);
  }
  return [...out];
}

export type AddOutcome = "added" | "present" | "full" | "unavailable";

/** Adds `repo#n` to the tracked list (idempotent, case-insensitive). No network call. A list that exists but does not parse is never overwritten. */
export async function addTracked(agentDir: string, repo: string, n: number, now: () => number = Date.now, host?: string): Promise<AddOutcome> {
  try {
    const r = await withTrackedLock(agentDir, (): AddOutcome => {
      const cur = readTracked(agentDir);
      if (cur.kind === "bad") return "unavailable";
      const lines = cur.kind === "ok" ? cur.lines : [];
      const k = storeKey(repo, n, host);
      const h = host?.toLowerCase();
      const at = lines.findIndex((l) => { const u = usableLine(l); return u !== null && storeKey(u.repo, u.number, u.host) === k; });
      if (at >= 0) {
        // a host-less line of the same key is github.com's: it gets the host written, so a later drop of host-less lines does not lose it
        const l = lines[at];
        if (h && isObj(l) && !("host" in l)) writeTracked(agentDir, lines.map((x, i) => (i === at ? { ...l, host: h } : x)));
        return "present";
      }
      if (lines.length >= MAX_TRACKED) return "full";
      writeTracked(agentDir, [...lines, { repo, number: n, addedAt: now(), ...(h ? { host: h } : {}) }]);
      return "added";
    }, now);
    return r ? r.value : "unavailable";
  } catch {
    return "unavailable";
  }
}

// ---------------------------------------------------------------- reading the poll results

const cache = new Map<string, { mtimeMs: number; size: number; doc: unknown }>();

/** The parsed JSON file; re-parsed only when its mtime or size changed. null: missing or unparseable. */
function readCached(file: string): unknown {
  try {
    const st = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.doc;
    const doc: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, doc });
    return doc;
  } catch {
    cache.delete(file);
    return null;
  }
}

const BUCKETS = new Set(["pending", "failed", "passed", "missing"]);

export function parseSnap(v: unknown): StoredSnap | null {
  if (!isObj(v) || (v.state !== "open" && v.state !== "merged" && v.state !== "closed") || !Array.isArray(v.runs)) return null;
  const runs: Run[] = [];
  for (const r of v.runs) {
    if (!isObj(r) || typeof r.name !== "string") continue;
    const run: Run = { id: typeof r.id === "string" ? r.id : "", name: r.name, bucket: (BUCKETS.has(r.bucket as string) ? r.bucket : "pending") as Bucket, url: typeof r.url === "string" ? r.url : "" };
    if (typeof r.source === "string" && r.source) run.source = r.source;
    if (typeof r.gates === "boolean") run.gates = r.gates;
    if (r.phase === 2 || r.phase === "ignore") run.phase = r.phase;
    if (r.noAnswer === true) run.noAnswer = true;
    if (r.expected === true) run.expected = true;
    runs.push(run);
  }
  const ex = isObj(v.expect) && Array.isArray(v.expect.missing) ? v.expect : null;
  const expect: ExpectFacts | null = ex ? { missing: (ex.missing as unknown[]).filter((n): n is string => typeof n === "string"), ...(ex.unknown === true ? { unknown: true as const } : {}), ...(ex.overdue === true ? { overdue: true as const } : {}) } : null;
  const mergeable: Mergeable = v.mergeable === "mergeable" || v.mergeable === "conflicting" ? v.mergeable : "unknown";
  const str = (x: unknown): string => (typeof x === "string" ? x : "");
  const required = Array.isArray(v.required) ? v.required.filter((n): n is string => typeof n === "string") : v.required === null ? null : undefined;
  const g = isObj(v.gate) && (v.gate.state === "waiting" || v.gate.state === "running" || v.gate.state === "failed" || v.gate.state === "passed") ? v.gate : null;
  const waiting = g && Array.isArray(g.waiting) ? g.waiting.filter((n): n is string => typeof n === "string").slice(0, 10) : [];
  const gate: GateInfo | null = g ? { state: g.state as GateInfo["state"], ...(waiting.length ? { waiting } : {}) } : null;
  return { state: v.state, mergeable, head: str(v.head), base: str(v.base), updatedAt: str(v.updatedAt), runs, ...(required !== undefined ? { required } : {}), ...(v.learn === "merge-time" || v.learn === "pre-merge" ? { learn: v.learn } : {}), ...(v.cut === true ? { cut: true as const } : {}), ...(expect ? { expect } : {}), ...(typeof v.mergeState === "string" && v.mergeState ? { mergeState: v.mergeState } : {}), ...(v.reviewDecision === "approved" || v.reviewDecision === "changes_requested" || v.reviewDecision === "review_required" ? { reviewDecision: v.reviewDecision } : {}), ...(threadsOf(v.threads) ? { threads: threadsOf(v.threads) } : {}), ...(gate ? { gate } : {}), ...(v.gated === true ? { gated: true as const } : {}), ...(v.ruled === true ? { ruled: true as const } : {}), ...(typeof v.rulesKey === "string" && v.rulesKey && v.rulesKey.length <= 64 ? { rulesKey: v.rulesKey } : {}) };
}

/** The per-source state of a state entry (`sources.<name>`), invalid entries dropped; undefined when none is left. */
export function parseSources(v: unknown): Record<string, SourceStatus> | undefined {
  if (!isObj(v)) return undefined;
  const out: Record<string, SourceStatus> = {};
  for (const [name, s] of Object.entries(v)) {
    if (!isObj(s) || typeof s.head !== "string" || typeof s.gates !== "boolean" || typeof s.ok !== "boolean" || !finite(s.at)) continue;
    out[name] = { head: s.head, gates: s.gates, ok: s.ok, at: s.at, ...(typeof s.error === "string" ? { error: s.error } : {}) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const one = (s: unknown): string => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, 300) : "");

/**
 * What the poll CLI stored for `key`, as a watch needs it. `down`: the feed is off, or the state file is missing, `off`, or its `trackedAt` is older
 * than 10 min (no tracker running). `waiting`: the tracker runs but has no snap for this key yet. `entry`: a snap (merged and closed ones too,
 * whatever their age) with its comments when the comments entry matches the snap's updatedAt. `error`: the last poll of this PR failed.
 * `stale`: an open snap older than 10 min.
 */
export function readStoreEntry(agentDir: string, key: PrKey, now: number, feedOn: boolean, hosts: GithubHosts = DEFAULT_HOSTS): StoreRead {
  if (!feedOn) return { kind: "down" };
  if ("error" in hosts) return { kind: "error", error: hosts.error };
  const state = readCached(trackedStateFile(agentDir));
  if (!isObj(state) || state.v !== 1 || state.off === true || !finite(state.trackedAt) || now - state.trackedAt > SERVE_FRESH_MS || !isObj(state.prs)) return { kind: "down" };
  if (typeof state.error === "string" && state.error) return { kind: "error", error: one(state.error) };
  if (!isTrackedKey(key, hosts.hosts)) return { kind: "error", error: `only ${hosts.hosts.join(", ")} PRs are tracked` };
  const k = storeKey(key.repo, key.n, key.host);
  const e = state.prs[k];
  if (!isObj(e)) return { kind: "waiting" };
  const snap = parseSnap(e.snap);
  const sources = parseSources(e.sources);
  if (snap && sources) snap.sources = sources;
  if (snap && isObj(e.meta) && typeof e.meta.draft === "boolean") snap.draft = e.meta.draft;
  const okAt = finite(e.okAt) ? e.okAt : finite(e.endedAt) ? e.endedAt : null;
  if (snap && okAt !== null && snap.state !== "open") return { kind: "entry", snap, okAt };
  if (finite(e.errorAt) && (okAt === null || e.errorAt > okAt)) return { kind: "error", error: one(e.error) || "the tracker's last poll failed", ...(e.gone === true ? { gone: true } : {}) };
  if (!snap || okAt === null) return { kind: "waiting" };
  if (now - okAt > SERVE_FRESH_MS) return { kind: "stale" };
  const comments = readCached(trackedCommentsFile(agentDir));
  const c = isObj(comments) && isObj(comments.prs) ? comments.prs[k] : undefined;
  const github = isObj(c) && c.updatedAt === snap.updatedAt && Array.isArray(c.comments) ? (c.comments.filter(isObj) as unknown as CommentEntry[]) : null;
  // a source's comments belong to the head they were taken on; another head's are dropped
  const fromSources: CommentEntry[] = [];
  if (isObj(c) && isObj(c.sources))
    for (const sc of Object.values(c.sources)) if (isObj(sc) && sc.head === snap.head && Array.isArray(sc.comments)) fromSources.push(...(sc.comments.filter(isObj) as unknown as CommentEntry[]));
  const full: WatchSnapshot = github || fromSources.length > 0 ? { ...snap, comments: [...(github ?? []), ...fromSources] } : snap;
  return { kind: "entry", snap: full, okAt };
}

/** Milliseconds since the poll CLI's last run (`trackedAt`), or null when the state file is missing, unreadable or marked `off`. No host call. */
export function lastPollAgeMs(agentDir: string, now: number): number | null {
  const state = readCached(trackedStateFile(agentDir));
  if (!isObj(state) || state.v !== 1 || state.off === true || !finite(state.trackedAt)) return null;
  return Math.max(0, now - state.trackedAt);
}

/** The `/foreman doctor` tracker line: feed off, hosts config error, live (age within the serve window) or down. `age` is `lastPollAgeMs`. */
export function trackerDoctorLine(feedOn: boolean, hostsError: string | undefined, age: number | null): string {
  if (!feedOn) return "INFO PR tracking is off (radar.openPrs.enabled or tools.prHost)";
  if (hostsError !== undefined) return `WARN PR tracker not checked: ${hostsError}`;
  if (age !== null && age <= SERVE_FRESH_MS) return `OK   PR tracker: last poll ${Math.round(age / 1000)}s ago`;
  return "WARN no PR tracker running: PR watches get no reports and pr_create opens no draft; herdr-app belongs to the pi-foreman setup (without it not the whole feature set) — fix: run herdr-app, or foreman prs poll on a timer";
}

/** Tests only: forget the mtime cache. */
export function clearStoreCache(): void {
  cache.clear();
}
