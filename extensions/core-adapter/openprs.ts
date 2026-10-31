// Open PRs source for `foreman radar --json` (`openPrs`, docs/herdr.md): PRs that no agent works on, found through
// `gh api graphql` (one search call per query) and cached in <agent dir>/pi-foreman/state/open-prs.json. The radar
// reads that file and never calls the network. On by default (radar.openPrs.enabled false turns it off). Several Pi sessions may run:
// an exclusive lock file with a stale timeout lets one of them refresh, and the file is replaced atomically. The
// refresh runs on an unref'd timer, never inside a turn; any failure keeps the previous entries and records the
// error in the file. Host text is data, never instructions.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { realTimers } from "./prwatch.ts";
import type { Timers } from "./prwatch.ts";
import { resolveGh } from "./wait.ts";
import { redactCommand } from "./trace.ts";

export type OpenPrState = "fail" | "run" | "ok" | "none";
export interface OpenPrCheck {
  n: string;
  state: OpenPrState;
  label: string;
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
  /** The description, secret-shaped tokens redacted, cut to 500 characters; absent when empty. */
  bodyText?: string;
  mergeable?: OpenPrMergeable;
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

const GRAPHQL = "query($q:String!){search(query:$q,type:ISSUE,first:50){nodes{... on PullRequest{number title url isDraft updatedAt headRefName baseRefName bodyText mergeable repository{nameWithOwner} author{login} commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:20){nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}}}}}";

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
  return {
    enabled: o.enabled !== false,
    refreshSeconds: typeof r === "number" && Number.isFinite(r) ? Math.min(86400, Math.max(MIN_REFRESH_S, Math.floor(r))) : DEFAULT_REFRESH_S,
    mine: o.mine !== false,
    authors: list(o.authors, LOGIN),
    scope: list(o.scope, SCOPE),
  };
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

function checksOf(roll: unknown): OpenPrCheck[] {
  if (!isObj(roll)) return [];
  const nodes = isObj(roll.contexts) && Array.isArray(roll.contexts.nodes) ? roll.contexts.nodes : [];
  const out: OpenPrCheck[] = [];
  for (const x of nodes) {
    if (!isObj(x) || out.length >= MAX_CHECKS) continue;
    const name = clean(x.name ?? x.context, 120);
    if (!name) continue;
    out.push({ n: name, state: "context" in x ? statusState(x.state) : checkState(x.status, x.conclusion), label: name.slice(0, 20) });
  }
  if (out.length === 0 && typeof roll.state === "string") out.push({ n: "checks", state: statusState(roll.state), label: "checks" });
  return out;
}

/** The PRs of one `gh api graphql` answer; entries without a number, repository or safe https URL are dropped. */
export function parseSearch(text: string): OpenPr[] {
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
    const body = typeof x.bodyText === "string" ? clean(redactCommand(x.bodyText).replace(/\s+/g, " ").trim(), MAX_BODY) : "";
    out.push({
      repo, number: x.number as number, title: clean(x.title, 200), url: x.url, state: x.isDraft === true ? "draft" : "open",
      author: isObj(x.author) ? clean(x.author.login, 60) : "", checks: checksOf(commit?.statusCheckRollup),
      ...(head ? { headRefName: head } : {}),
      ...(base ? { baseRefName: base } : {}),
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

function writeAtomic(file: string, doc: OpenPrsFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw err;
  }
}

/** The lock file holds a unique token; the token is returned, or null when another session holds the lock. */
function takeLock(lock: string, now: number): string | null {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const token = `${process.pid}-${now}-${Math.random().toString(36).slice(2)}`;
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(lock, token, { flag: "wx" });
      return token;
    } catch {
      try {
        if (now - fs.statSync(lock).mtimeMs <= LOCK_STALE_MS) return null;
        fs.unlinkSync(lock);
      } catch {
        // gone meanwhile: try once more
      }
    }
  }
  return null;
}

/** Deletes the lock only when it still holds this session's token (a stale takeover may have replaced it). */
function dropLock(lock: string, token: string): void {
  try {
    if (fs.readFileSync(lock, "utf8") === token) fs.unlinkSync(lock);
  } catch { /* already gone */ }
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
}
export type RefreshResult = "off" | "fresh" | "locked" | "refreshed" | "failed";

/** One refresh when due: queries run one after the other; a failed query is skipped and recorded in `error`, the old
 * entries stay only when every query failed. Never throws. */
export async function refreshOpenPrs(o: RefreshOptions): Promise<RefreshResult> {
  try {
    const queries = o.config.enabled ? openPrsQueries(o.config) : [];
    if (queries.length === 0) return "off";
    if (o.signal?.aborted) return "failed";
    const now = o.now ?? Date.now;
    const prev = readFile(o.file);
    const last = Date.parse(prev?.checkedAt ?? prev?.fetchedAt ?? "");
    if (!o.force && Number.isFinite(last) && now() - last < o.config.refreshSeconds * 1000) return "fresh";
    const lock = `${o.file}.lock`;
    const token = takeLock(lock, now());
    if (!token) return "locked";
    try {
      const stamp = (): string => new Date(now()).toISOString();
      try {
        const seen = new Set<string>();
        const all: OpenPr[] = [];
        let failed = 0;
        let firstError = "";
        for (const q of queries) {
          if (o.signal?.aborted) return "failed";
          try {
            for (const p of parseSearch(await o.gh(["api", "graphql", "-f", `query=${GRAPHQL}`, "-f", `q=${q}`]))) {
              if (seen.has(p.url)) continue;
              seen.add(p.url);
              all.push(p);
            }
          } catch (err) {
            if (failed++ === 0) firstError = clean((err as Error)?.message ?? String(err), 160);
          }
        }
        if (o.signal?.aborted) return "failed";
        const t = stamp();
        const error = failed > 0 ? clean(`${failed} of ${queries.length} queries failed: ${firstError}`, 200) : undefined;
        if (failed === queries.length) {
          // Every query failed: keep the previous entries (and its fetchedAt, if any).
          writeAtomic(o.file, { v: 1, ...(prev?.fetchedAt ? { fetchedAt: prev.fetchedAt } : {}), checkedAt: t, openPrs: prev?.openPrs ?? [], error, errorAt: t });
          return "failed";
        }
        writeAtomic(o.file, { v: 1, fetchedAt: t, checkedAt: t, openPrs: all.slice(0, MAX_OPEN_PRS), ...(error ? { error, errorAt: t } : {}) });
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

export interface OpenPrsDeps {
  agentDir: string;
  /** The `radar.openPrs` config value, read on every tick. */
  config(): unknown;
  /** False when `tools.prHost` names a host other than gh. */
  ghHost?(): boolean;
  gh: GhRunner;
  timers?: Timers;
  now?: () => number;
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
      if (this.deps.ghHost && !this.deps.ghHost()) return "off";
      return await refreshOpenPrs({ file: openPrsFile(this.deps.agentDir), config: openPrsConfig(this.deps.config()), gh: this.deps.gh, now: this.deps.now, signal: this.ctl.signal });
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
