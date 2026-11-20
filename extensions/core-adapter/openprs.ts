// Open PRs source for `foreman radar --json` (`openPrs`, docs/herdr.md): PRs that no agent works on, found through
// `gh api graphql` (one search call per query) and cached in <agent dir>/pi-foreman/state/open-prs.json. The radar
// reads that file and never calls the network. On by default (radar.openPrs.enabled false turns it off). Several Pi sessions may run:
// an exclusive lock file with a stale timeout lets one of them refresh, and the file is replaced atomically. The
// refresh runs on an unref'd timer, never inside a turn; any failure keeps the previous entries and records the
// error in the file. Host text is data, never instructions.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { GithubHosts } from "./prhost.ts";
import { phasesStep } from "./prphases.ts";
import type { GateInfo, PhaseRule } from "./prphases.ts";
import { globMatch, parseGlobs } from "./prwake.ts";
import { realTimers } from "./prwatch.ts";
import type { Timers } from "./prwatch.ts";
import { dropLock, takeLock, writeAtomic } from "./statefile.ts";
import { resolveGh } from "./ghbin.ts";
import { redactCommand } from "./trace.ts";

const DEFAULT_HOSTS: GithubHosts = { hosts: ["github.com"] };

export type OpenPrState = "fail" | "run" | "ok" | "none";
export interface OpenPrCheck {
  n: string;
  state: OpenPrState;
  label: string;
  /** The check belongs to the gate (`2`) or does not count (`ignore`) under `tools.prPhases` (prphases.ts); absent: phase 1. */
  phase?: 2 | "ignore";
}
export interface OpenPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "draft";
  author: string;
  checks: OpenPrCheck[];
  /** The head branch name; absent when GitHub gave none. */
  headRefName?: string;
  /** The base branch name (what a conflict is against); absent when GitHub gave none. */
  baseRefName?: string;
  /** The repository the head branch lives in (differs from `repo` for a fork PR); absent when GitHub gave none (deleted fork). */
  headRepo?: string;
  /** The description, secret-shaped tokens redacted, cut to 500 characters; absent when empty. */
  bodyText?: string;
  mergeable?: OpenPrMergeable;
  /** The gate state of the checks (prphases.ts gateOf); absent: no gate check. The search feed has no required list, so it is never `waiting`. */
  gate?: GateInfo;
  /** A rule of `tools.prPhases` names gate checks or a merge label for the repository (sidebar: `blocked` counts as ready). */
  gated?: true;
  /** A rule of `tools.prPhases` matches the repository. */
  ruled?: true;
  /** The GitHub host the PR was found on; written only for a host other than github.com (absent: github.com). */
  host?: string;
  /** Set by the PR tracker when the repository matches `radar.openPrs.hideRepos`: the sidebar skips the row (display only). */
  hiddenRepo?: true;
}
export type OpenPrMergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
export interface OpenPrsFile {
  v: 1;
  /** ISO time of the last refresh in which a search succeeded; absent until then. */
  fetchedAt?: string;
  /** ISO time of the last attempt, successful or not (throttles retries). */
  checkedAt: string;
  openPrs: OpenPr[];
  error?: string;
  errorAt?: string;
}
export interface OpenPrsConfig {
  enabled: boolean;
  refreshSeconds: number;
  mine: boolean;
  authors: string[];
  scope: string[];
  /** Globs over the lowercased `owner/name` of repositories the sidebar hides; empty hides nothing. */
  hideRepos: string[];
  /** Why a given `hideRepos` value was dropped; absent when it was usable. */
  hideError?: string;
}

export const DEFAULT_REFRESH_S = 120;
export const MIN_REFRESH_S = 60;
export const MAX_OPEN_PRS = 100;
export const MAX_CHECKS = 20;
export const MAX_BODY = 500;
const MAX_QUERIES = 20;
const GH_TIMEOUT_MS = 30_000;
// Longer than the worst-case refresh (every query running into its timeout) plus two minutes of margin.
const LOCK_STALE_MS = MAX_QUERIES * GH_TIMEOUT_MS + 2 * 60_000;
const TICK_MS = 60_000;
const FIRST_TICK_MS = 3_000;

/** An https URL of URL characters only: no whitespace, control characters or `" ' < > ^ | & \` and backtick. */
const SAFE_URL = /^https:\/\/[A-Za-z0-9][A-Za-z0-9\-._~:/?#[\]@!$()*+,;=%]*$/;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\/[A-Za-z0-9._-]{1,100})?$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?$/;

export const openPrsFile = (agentDir: string): string => path.join(agentDir, "pi-foreman", "state", "open-prs.json");

const GRAPHQL = "query($q:String!){search(query:$q,type:ISSUE,first:50){nodes{... on PullRequest{number title url isDraft updatedAt headRefName baseRefName bodyText mergeable repository{nameWithOwner} headRepository{nameWithOwner} author{login} commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:20){nodes{__typename ... on CheckRun{name status conclusion startedAt completedAt checkSuite{app{slug} workflowRun{event workflow{name}}}} ... on StatusContext{context state createdAt}}}}}}}}}}}";

const clean = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, max) : "");
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function safeHttpsUrl(v: unknown): v is string {
  return typeof v === "string" && v.length <= 2048 && SAFE_URL.test(v);
}

/** The effective settings from the `radar.openPrs` config value; unusable entries are dropped. */
export function openPrsConfig(raw: unknown): OpenPrsConfig {
  const o = isObj(raw) ? raw : {};
  const list = (v: unknown, re: RegExp): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && re.test(x)) : []);
  const r = o.refreshSeconds;
  let hideRepos: string[] = [];
  let hideError: string | undefined;
  if (o.hideRepos !== undefined && !(Array.isArray(o.hideRepos) && o.hideRepos.length === 0)) {
    const g = parseGlobs(o.hideRepos, "value");
    if (typeof g === "string") hideError = `radar.openPrs.hideRepos: ${g}`;
    else hideRepos = g.map((x) => x.toLowerCase());
  }
  return {
    enabled: o.enabled !== false,
    refreshSeconds: typeof r === "number" && Number.isFinite(r) ? Math.min(86400, Math.max(MIN_REFRESH_S, Math.floor(r))) : DEFAULT_REFRESH_S,
    mine: o.mine !== false,
    authors: list(o.authors, LOGIN),
    scope: list(o.scope, SCOPE),
    hideRepos,
    ...(hideError ? { hideError } : {}),
  };
}

/** True when `repo` (any case) matches one of the `hideRepos` globs (the matcher of `tools.prSources.<name>.repos`). */
export function hiddenRepo(globs: string[], repo: string): boolean {
  const r = repo.toLowerCase();
  return globs.some((g) => globMatch(g, r));
}

/** Marks the entries of open-prs.json whose repo matches `globs` and unmarks the others, under the refresh lock; rewrites the file only when a mark changed. Never throws; busy: the next poll retries. */
export function remarkOpenPrs(file: string, globs: string[], now: number): void {
  try {
    const lock = `${file}.lock`;
    const token = takeLock(lock, now, LOCK_STALE_MS);
    if (!token) return;
    try {
      const cur = readFile(file);
      if (!cur) return;
      let changed = false;
      const openPrs = cur.openPrs.map((p) => {
        const want = hiddenRepo(globs, p.repo);
        if (want === (p.hiddenRepo === true)) return p;
        changed = true;
        const { hiddenRepo: _drop, ...rest } = p;
        return want ? { ...rest, hiddenRepo: true as const } : rest;
      });
      if (changed) writeAtomic(file, { ...cur, openPrs });
    } finally {
      dropLock(lock, token);
    }
  } catch {
    // unwritable: the next poll retries
  }
}

/** The search is off: drop the entries of `file` under its lock, once. Returns how many were dropped (0: nothing was written). Never throws. */
export function clearOpenPrs(file: string, now: number): number {
  try {
    const lock = `${file}.lock`;
    const token = takeLock(lock, now, LOCK_STALE_MS);
    if (!token) return 0;
    try {
      const cur = readFile(file);
      if (!cur || cur.openPrs.length === 0) return 0;
      writeAtomic(file, { v: 1, checkedAt: new Date(now).toISOString(), openPrs: [] });
      return cur.openPrs.length;
    } finally {
      dropLock(lock, token);
    }
  } catch {
    return 0; // unwritable: the next poll retries
  }
}

/** The search strings: mine (author and review requested), and each bot author inside each scope entry (never unscoped). */
export function openPrsQueries(c: OpenPrsConfig): string[] {
  const q: string[] = [];
  if (c.mine) q.push("is:pr is:open author:@me", "is:pr is:open review-requested:@me");
  for (const a of c.authors) {
    const who = a.endsWith("[bot]") ? `author:app/${a.slice(0, -5)}` : `author:${a}`;
    // `org:<login>` also matches user accounts (verified against GitHub search: same count as `user:` and `owner:`).
    for (const s of c.scope) q.push(`is:pr is:open ${who} ${OWNER.test(s) ? "org" : "repo"}:${s}`);
  }
  return q.slice(0, MAX_QUERIES);
}

function checkState(status: unknown, conclusion: unknown): OpenPrState {
  if (typeof status === "string" && status !== "COMPLETED") return "run";
  switch (conclusion) {
    case "SUCCESS": case "NEUTRAL": case "SKIPPED": return "ok";
    case "FAILURE": case "TIMED_OUT": case "CANCELLED": case "ACTION_REQUIRED": case "STARTUP_FAILURE": return "fail";
    default: return "none";
  }
}

function statusState(v: unknown): OpenPrState {
  if (v === "SUCCESS") return "ok";
  if (v === "FAILURE" || v === "ERROR") return "fail";
  if (v === "PENDING" || v === "EXPECTED") return "run";
  return "none";
}

/** The identity a check counts by, null when unknown (such a run is never merged with another): a status context by its context, an
 * Actions check run by workflow name + event + name, a check run of another app by app slug + name. */
function checkKey(x: Record<string, unknown>, name: string): string | null {
  if ("context" in x) return JSON.stringify(["ctx", name]);
  const suite = isObj(x.checkSuite) ? x.checkSuite : null;
  if (!suite) return null;
  const run = isObj(suite.workflowRun) ? suite.workflowRun : null;
  const wf = run && isObj(run.workflow) ? run.workflow : null;
  const wname = wf ? clean(wf.name, 120) : "";
  if (wname) return JSON.stringify(["run", wname, typeof run?.event === "string" ? run.event : null, name]);
  const slug = isObj(suite.app) ? clean(suite.app.slug, 60) : "";
  return slug && slug !== "github-actions" ? JSON.stringify(["app", slug, name]) : null;
}

/** Order of the runs of one check: start time (none yet, queued: newest), then completion time (none: newest). */
function newestRank(x: Record<string, unknown>): [number, number] {
  const at = (v: unknown): number => {
    const t = typeof v === "string" && !v.startsWith("0001-") ? Date.parse(v) : NaN;
    return Number.isNaN(t) ? Infinity : t;
  };
  return "context" in x ? [at(x.createdAt), Infinity] : [at(x.startedAt), at(x.completedAt)];
}

/** One entry per check: its newest run (a re-run supersedes the runs it replaces), in the order of first appearance. */
function checksOf(roll: unknown): OpenPrCheck[] {
  if (!isObj(roll)) return [];
  const nodes = isObj(roll.contexts) && Array.isArray(roll.contexts.nodes) ? roll.contexts.nodes : [];
  const latest = new Map<string, { x: Record<string, unknown>; name: string }>();
  let seq = 0;
  for (const x of nodes) {
    if (!isObj(x)) continue;
    const name = clean(x.name ?? x.context, 120);
    if (!name) continue;
    const key = checkKey(x, name) ?? `single:${seq++}`;
    const old = latest.get(key);
    if (old) {
      const [a, b] = [newestRank(x), newestRank(old.x)];
      if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) continue;
    }
    latest.set(key, { x, name });
  }
  const out: OpenPrCheck[] = [];
  for (const { x, name } of latest.values()) {
    if (out.length >= MAX_CHECKS) break;
    out.push({ n: name, state: "context" in x ? statusState(x.state) : checkState(x.status, x.conclusion), label: name.slice(0, 20) });
  }
  if (out.length === 0 && typeof roll.state === "string") out.push({ n: "checks", state: statusState(roll.state), label: "checks" });
  return out;
}

const BUCKET: Record<OpenPrState, "pending" | "failed" | "passed"> = { run: "pending", fail: "failed", ok: "passed", none: "passed" };

/** The checks of one PR sorted by the rules of its repository (prphases.ts, the tracker's helper): `phase` per check, the gate state, `gated` and `ruled`. */
function sortChecks(phases: readonly PhaseRule[], repo: string, checks: OpenPrCheck[]): { checks: OpenPrCheck[]; gate?: GateInfo; gated?: true; ruled?: true } {
  const sorted = phasesStep(phases, repo, checks.map((c) => ({ id: c.n, name: c.n, bucket: BUCKET[c.state], url: "" })));
  return { checks: checks.map((c, i) => (sorted.runs[i].phase ? { ...c, phase: sorted.runs[i].phase } : c)), ...(sorted.gate ? { gate: sorted.gate } : {}), ...(sorted.gated ? { gated: true as const } : {}), ...(sorted.ruled ? { ruled: true as const } : {}) };
}

/** The PRs of one `gh api graphql` answer; entries without a number, repository or safe https URL are dropped. */
export function parseSearch(text: string, phases: readonly PhaseRule[] = []): OpenPr[] {
  const doc: unknown = JSON.parse(text);
  const data = isObj(doc) && isObj(doc.data) ? doc.data : null;
  const nodes = data && isObj(data.search) && Array.isArray(data.search.nodes) ? data.search.nodes : null;
  if (!nodes) throw new Error("gh: unexpected GraphQL answer");
  const out: OpenPr[] = [];
  for (const x of nodes) {
    if (!isObj(x) || !Number.isInteger(x.number) || !safeHttpsUrl(x.url)) continue;
    const repo = isObj(x.repository) ? clean(x.repository.nameWithOwner, 140) : "";
    if (!repo) continue;
    const commits = isObj(x.commits) && Array.isArray(x.commits.nodes) ? x.commits.nodes : [];
    const commit = isObj(commits[0]) && isObj(commits[0].commit) ? commits[0].commit : null;
    const head = clean(x.headRefName, 255);
    const base = clean(x.baseRefName, 255);
    const headRepo = isObj(x.headRepository) ? clean(x.headRepository.nameWithOwner, 140) : "";
    const body = typeof x.bodyText === "string" ? clean(redactCommand(x.bodyText).replace(/\s+/g, " ").trim(), MAX_BODY) : "";
    const checks = checksOf(commit?.statusCheckRollup);
    const sorted = phases.length > 0 ? sortChecks(phases, repo, checks) : null;
    out.push({
      repo, number: x.number as number, title: clean(x.title, 200), url: x.url, state: x.isDraft === true ? "draft" : "open",
      author: isObj(x.author) ? clean(x.author.login, 60) : "", checks: sorted?.checks ?? checks,
      ...(sorted?.gate ? { gate: sorted.gate } : {}),
      ...(sorted?.gated ? { gated: true as const } : {}),
      ...(sorted?.ruled ? { ruled: true as const } : {}),
      ...(head ? { headRefName: head } : {}),
      ...(base ? { baseRefName: base } : {}),
      ...(headRepo ? { headRepo } : {}),
      ...(body ? { bodyText: body } : {}),
      ...(x.mergeable === "MERGEABLE" || x.mergeable === "CONFLICTING" || x.mergeable === "UNKNOWN" ? { mergeable: x.mergeable } : {}),
    });
  }
  return out;
}

export type GhRunner = (args: string[]) => Promise<string>;

export function realGh(cwd: string, env: NodeJS.ProcessEnv = process.env): GhRunner {
  return (args) => new Promise((resolve, reject) => {
    const gh = resolveGh(cwd, env);
    if (!gh) return reject(new Error("gh is not installed"));
    execFile(gh, args, { cwd, timeout: GH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...env, GH_PROMPT_DISABLED: "1" } }, (err, stdout, stderr) => {
      if (err) return reject(new Error(clean(String(stderr || "").trim() || err.message, 200)));
      resolve(String(stdout));
    });
  });
}

function readFile(file: string): OpenPrsFile | null {
  try {
    const j: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObj(j) && Array.isArray(j.openPrs) && (j.fetchedAt === undefined || typeof j.fetchedAt === "string") ? (j as unknown as OpenPrsFile) : null;
  } catch {
    return null;
  }
}

export interface RefreshOptions {
  file: string;
  config: OpenPrsConfig;
  gh: GhRunner;
  now?: () => number;
  /** Refresh even when the file is fresh. */
  force?: boolean;
  /** Aborted by `stop()`: a refresh in flight then writes nothing and only drops the lock it holds. */
  signal?: AbortSignal;
  /** tools.prGithubHosts: one search per listed host. Absent: github.com only. `{error}`: no gh call, the error is recorded. */
  hosts?: GithubHosts;
  /** tools.prPhases: the checks of each found PR are sorted by the rules of its repository. Absent: none. */
  phases?: readonly PhaseRule[];
}
export type RefreshResult = "off" | "fresh" | "locked" | "refreshed" | "failed";

/** One refresh when due: queries run one after the other; a failed query is skipped and recorded in `error`, the old
 * entries stay only when every query failed. Never throws. */
export async function refreshOpenPrs(o: RefreshOptions): Promise<RefreshResult> {
  try {
    const queries = o.config.enabled ? openPrsQueries(o.config) : [];
    if (queries.length === 0) return "off";
    const hostSet = o.hosts ?? DEFAULT_HOSTS;
    if (o.signal?.aborted) return "failed";
    const now = o.now ?? Date.now;
    const prev = readFile(o.file);
    const last = Date.parse(prev?.checkedAt ?? prev?.fetchedAt ?? "");
    if (!o.force && Number.isFinite(last) && now() - last < o.config.refreshSeconds * 1000) return "fresh";
    const lock = `${o.file}.lock`;
    const token = takeLock(lock, now(), LOCK_STALE_MS);
    if (!token) return "locked";
    try {
      // The file as it is under the lock (the tracker may have re-marked it since the read above): the marks are copied from it per repo.
      const cur = readFile(o.file);
      const marked = new Set((cur?.openPrs ?? []).filter((p) => p.hiddenRepo === true && typeof p.repo === "string").map((p) => p.repo.toLowerCase()));
      const keep = (p: OpenPr): OpenPr => (marked.has(p.repo.toLowerCase()) ? { ...p, hiddenRepo: true } : p);
      const stamp = (): string => new Date(now()).toISOString();
      try {
        if ("error" in hostSet) {
          // tools.prGithubHosts is unset or invalid: no search, the previous entries stay
          const t = stamp();
          writeAtomic(o.file, { v: 1, ...(prev?.fetchedAt ? { fetchedAt: prev.fetchedAt } : {}), checkedAt: t, openPrs: cur?.openPrs ?? [], error: clean(hostSet.error, 200), errorAt: t });
          return "failed";
        }
        const hosts = hostSet.hosts;
        // The query budget is shared round-robin: every listed host gets its first query before any gets its second.
        const jobs: [string, string][] = [];
        for (const q of queries) for (const h of hosts) jobs.push([h, q]);
        jobs.length = Math.min(jobs.length, MAX_QUERIES);
        const seen = new Set<string>();
        const all: OpenPr[] = [];
        const tried = new Map<string, number>();
        const missed = new Map<string, number>();
        let failed = 0;
        let firstError = "";
        for (const [h, q] of jobs) {
          if (o.signal?.aborted) return "failed";
          tried.set(h, (tried.get(h) ?? 0) + 1);
          const host = h === "github.com" ? [] : ["--hostname", h];
          try {
            for (const p of parseSearch(await o.gh(["api", "graphql", ...host, "-f", `query=${GRAPHQL}`, "-f", `q=${q}`]), o.phases)) {
              if (seen.has(p.url)) continue;
              seen.add(p.url);
              all.push(h === "github.com" ? p : { ...p, host: h });
            }
          } catch (err) {
            missed.set(h, (missed.get(h) ?? 0) + 1);
            if (failed++ === 0) firstError = clean(`${hosts.length > 1 ? `${h}: ` : ""}${(err as Error)?.message ?? String(err)}`, 160);
          }
        }
        if (o.signal?.aborted) return "failed";
        const t = stamp();
        const error = failed > 0 ? clean(`${failed} of ${jobs.length} queries failed: ${firstError}`, 200) : undefined;
        if (failed === jobs.length) {
          // Every query failed: keep the previous entries (and its fetchedAt, if any).
          writeAtomic(o.file, { v: 1, ...(prev?.fetchedAt ? { fetchedAt: prev.fetchedAt } : {}), checkedAt: t, openPrs: cur?.openPrs ?? [], error, errorAt: t });
          return "failed";
        }
        // A host whose every query failed keeps its previous entries; the other hosts' results are not hidden.
        const lost = new Set([...tried].filter(([h, n]) => missed.get(h) === n).map(([h]) => h));
        for (const p of cur?.openPrs ?? []) {
          if (!lost.has(p.host ?? "github.com") || seen.has(p.url)) continue;
          seen.add(p.url);
          all.push(p);
        }
        writeAtomic(o.file, { v: 1, fetchedAt: t, checkedAt: t, openPrs: all.map(keep).slice(0, MAX_OPEN_PRS), ...(error ? { error, errorAt: t } : {}) });
        return "refreshed";
      } catch {
        return "failed";
      }
    } finally {
      dropLock(lock, token);
    }
  } catch {
    return "failed";
  }
}

/** Stats one file as `mtimeMs:size`, or "missing" (a missing file is its own state). */
function statPrint(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
}

/**
 * A stat fingerprint of the config layers that hold `radar.openPrs` and the PR host keys: the user layer `<agentDir>/foreman.json`
 * and the overlay layer (`<agentDir>/npm/node_modules`, each scoped `@*` directory in it, every `package.json` with
 * `pi.foreman.config` and the config file it points to, as scripts/foreman_config.py `discover_l3` finds them).
 */
export function configFingerprint(agentDir: string): string {
  const parts = [`L2 ${statPrint(path.join(agentDir, "foreman.json"))}`];
  const nm = path.join(agentDir, "npm", "node_modules");
  parts.push(`nm ${statPrint(nm)}`);
  const dirs: string[] = [];
  const subdirs = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => path.join(dir, e.name)).sort();
    } catch {
      return [];
    }
  };
  for (const d of subdirs(nm)) {
    if (path.basename(d).startsWith("@")) {
      parts.push(`scope ${d} ${statPrint(d)}`);
      dirs.push(...subdirs(d));
    } else dirs.push(d);
  }
  for (const d of dirs) {
    const pj = path.join(d, "package.json");
    let rel: unknown;
    try {
      rel = JSON.parse(fs.readFileSync(pj, "utf8"))?.pi?.foreman?.config;
    } catch {
      continue;
    }
    if (typeof rel !== "string") continue;
    parts.push(`pj ${pj} ${statPrint(pj)}`, `cfg ${path.join(d, rel)} ${statPrint(path.join(d, rel))}`);
  }
  return parts.join("\n");
}

/**
 * The config the refresher reads: the session's merged config until the fingerprint of the user and overlay layers changes, then a
 * reload through `load` (the session's provider and trusted flag). Only the refresher uses it; gates keep the session snapshot.
 */
export class ReloadingConfig<T> {
  private value: T;
  private print: string;
  private readonly agentDir: string;
  private readonly load: () => Promise<T>;
  private readonly accept: (v: T) => boolean;
  constructor(agentDir: string, initial: T, load: () => Promise<T>, accept: (v: T) => boolean = () => true) {
    this.agentDir = agentDir;
    this.load = load;
    this.accept = accept;
    this.value = initial;
    this.print = configFingerprint(agentDir);
  }
  current(): T {
    return this.value;
  }
  /** Reloads when the layers changed since the last look; a load that throws or that `accept` rejects (loadMergedConfig returns defaults instead of throwing) keeps the old value and is retried at the next call. */
  async refresh(): Promise<void> {
    const now = configFingerprint(this.agentDir);
    if (now === this.print) return;
    try {
      const next = await this.load();
      if (!this.accept(next)) return;
      this.value = next;
      this.print = now;
    } catch {}
  }
}

export interface OpenPrsDeps {
  agentDir: string;
  /** Awaited before each tick reads `config()` and `hosts()`. */
  prepare?(): Promise<void>;
  /** The `radar.openPrs` config value, read on every tick. */
  config(): unknown;
  /** False when `tools.prHost` names a host other than gh. */
  ghHost?(): boolean;
  gh: GhRunner;
  timers?: Timers;
  now?: () => number;
  /** tools.prGithubHosts, read on every tick; absent: github.com only. */
  hosts?(): GithubHosts;
  /** tools.prPhases, read on every tick; absent: none. */
  phases?(): readonly PhaseRule[];
}

/** Ticks once a minute (first tick after a few seconds); each tick refreshes only when the file is older than refreshSeconds. */
export class OpenPrsRefresher {
  private handle: unknown = null;
  private stopped = true;
  private busy = false;
  private ctl = new AbortController();

  private readonly deps: OpenPrsDeps;

  constructor(deps: OpenPrsDeps) {
    this.deps = deps;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.ctl.signal.aborted) this.ctl = new AbortController();
    this.arm(FIRST_TICK_MS);
  }

  stop(): void {
    this.stopped = true;
    this.ctl.abort();
    if (this.handle !== null) (this.deps.timers ?? realTimers).clear(this.handle);
    this.handle = null;
  }

  /** One tick (exposed for tests). */
  async tick(): Promise<RefreshResult> {
    if (this.busy) return "locked";
    this.busy = true;
    try {
      await this.deps.prepare?.();
      if (this.deps.ghHost && !this.deps.ghHost()) return "off";
      return await refreshOpenPrs({ file: openPrsFile(this.deps.agentDir), config: openPrsConfig(this.deps.config()), gh: this.deps.gh, now: this.deps.now, signal: this.ctl.signal, ...(this.deps.hosts ? { hosts: this.deps.hosts() } : {}), ...(this.deps.phases ? { phases: this.deps.phases() } : {}) });
    } catch {
      return "failed";
    } finally {
      this.busy = false;
    }
  }

  private arm(ms: number): void {
    this.handle = (this.deps.timers ?? realTimers).set(() => {
      void this.tick().finally(() => {
        if (!this.stopped) this.arm(TICK_MS);
      });
    }, ms);
  }
}
