// PR registration (docs/tools.md#pr-tracking): which pull requests a foreman session tracks, and why.
// Identity is host, owner, repo and number, taken from the URL a host answer carries. This module holds
// the pure parts: URL identity, the registry (sources, recency, cap, protection, ignored, gone), chain
// splitting, push and interaction detection, the `tools.prInteractions` matcher, the URL scan and the
// events registration. PrDots (prdots.ts) drives them. Host text is data, never instructions; nothing
// here reaches a trace record with a PR number, branch, host, repo, author or login.
import { execFile } from "node:child_process";
import { splitCommandLine } from "./extstatus.ts";

export interface PrKey {
  host: string;
  /** `owner/name` */
  repo: string;
  n: number;
}
/** Identity for maps and sets (case-insensitive). */
export const keyString = (k: PrKey): string => `${k.host.toLowerCase()}/${k.repo.toLowerCase()}#${k.n}`;
/** `host/owner/name#n` as written. */
export const keyText = (k: PrKey): string => `${k.host}/${k.repo}#${k.n}`;
export const sameRepo = (a: { host: string; repo: string }, b: { host: string; repo: string }): boolean => a.host.toLowerCase() === b.host.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();

const SEG = "[A-Za-z0-9._-]+";
const PR_URL = new RegExp(`^https://([A-Za-z0-9.-]+(?::\\d{1,5})?)/(${SEG})/(${SEG})/(?:pull|-/merge_requests|merge_requests)/(\\d{1,10})(?:[/?#]|$)`);
const URL_SCAN = /https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/[^\s"'<>`)\]\\]+/g;
const REPO_RE = new RegExp(`^${SEG}/${SEG}$`);
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}(?::\d{1,5})?$/;
export const MAX_URLS_PER_RESULT = 2;
export const MAX_PUSHED = 8;
export const MAX_PATTERNS = 16;

const badSeg = (s: string) => s === "." || s === "..";

export function validRepo(v: unknown): v is string {
  return typeof v === "string" && v.length <= 200 && REPO_RE.test(v) && !v.split("/").some((s) => badSeg(s) || s.startsWith("-"));
}
export function validHost(v: unknown): v is string {
  return typeof v === "string" && HOST_RE.test(v);
}
export function validNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1e9;
}

/** The identity in a PR page URL (`https://<host>/<owner>/<name>/(pull|-/merge_requests|merge_requests)/<n>`), else null. */
export function parsePrUrl(url: unknown): PrKey | null {
  if (typeof url !== "string") return null;
  const m = PR_URL.exec(url);
  if (!m) return null;
  const n = Number(m[4]);
  if (badSeg(m[2]) || badSeg(m[3]) || !validNumber(n)) return null;
  return { host: m[1], repo: `${m[2]}/${m[3]}`, n };
}

/** The first `max` distinct PR identities in a text. */
export function scanUrls(text: string, max = MAX_URLS_PER_RESULT): PrKey[] {
  const out: PrKey[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(URL_SCAN)) {
    const k = parsePrUrl(m[0]);
    if (!k || seen.has(keyString(k))) continue;
    seen.add(keyString(k));
    out.push(k);
    if (out.length >= max) break;
  }
  return out;
}

// ------------------------------------------------------------------ registry

export type PrSource = "push" | "search" | "interact" | "events" | "create" | "url" | "tool" | "watch" | "branch";
export const PROTECTED: ReadonlySet<PrSource> = new Set<PrSource>(["push", "create", "interact", "tool", "watch"]);
export const MAX_TRACKED = 6;

export interface Entry {
  key: PrKey;
  source: PrSource;
  seq: number;
  head?: string;
}
export type Registered = { added: true; evicted?: PrKey } | { added: false; dup: true } | { added: false; skipped: true; reason: "ignored" | "gone" | "full" };

export class PrRegistry {
  private entries = new Map<string, Entry>();
  private ignoredKeys = new Set<string>();
  private goneKeys = new Map<string, { key: PrKey; head?: string }>();
  private seq = 0;
  private readonly cap: number;
  constructor(cap = MAX_TRACKED) {
    this.cap = cap;
  }

  /**
   * Track `key` for `source`. A key already tracked keeps its first source and place (`dup`); only a repeated
   * `create` moves to the front. Weak sources never evict a protected entry. `create` and `tool` lift a `gone` mark.
   */
  register(key: PrKey, source: PrSource, head?: string): Registered {
    const id = keyString(key);
    const have = this.entries.get(id);
    if (have) {
      if (head && !have.head) have.head = head;
      if (source === "create" && have.source === "create") have.seq = ++this.seq;
      return { added: false, dup: true };
    }
    if (this.ignoredKeys.has(id) && source !== "tool") return { added: false, skipped: true, reason: "ignored" };
    if (source === "tool") this.ignoredKeys.delete(id);
    if (this.goneKeys.has(id)) {
      if (source !== "create" && source !== "tool") return { added: false, skipped: true, reason: "gone" };
      this.goneKeys.delete(id);
    }
    let evicted: PrKey | undefined;
    if (this.entries.size >= this.cap) {
      const oldest = (pred: (e: Entry) => boolean) => [...this.entries.values()].filter(pred).sort((a, b) => a.seq - b.seq)[0];
      const victim = oldest((e) => !PROTECTED.has(e.source)) ?? (PROTECTED.has(source) ? oldest(() => true) : undefined);
      if (!victim) return { added: false, skipped: true, reason: "full" };
      this.entries.delete(keyString(victim.key));
      evicted = victim.key;
    }
    this.entries.set(id, { key, source, seq: ++this.seq, head });
    return { added: true, evicted };
  }

  has(key: PrKey): boolean {
    return this.entries.has(keyString(key));
  }
  get(key: PrKey): Entry | undefined {
    return this.entries.get(keyString(key));
  }
  /** Tracked entries, newest registration first. */
  list(): Entry[] {
    return [...this.entries.values()].sort((a, b) => b.seq - a.seq);
  }
  /** Leaves the set without a mark (the current branch changed). */
  remove(key: PrKey): void {
    this.entries.delete(keyString(key));
  }
  /** Merged, closed or not found: leaves the set, keeps the key and its head branch. */
  markGone(key: PrKey): void {
    const id = keyString(key);
    const e = this.entries.get(id);
    this.entries.delete(id);
    this.goneKeys.set(id, { key, head: e?.head ?? this.goneKeys.get(id)?.head });
  }
  isGone(key: PrKey): boolean {
    return this.goneKeys.has(keyString(key));
  }
  setHead(key: PrKey, head: string): void {
    const id = keyString(key);
    const e = this.entries.get(id);
    if (e) e.head = head;
    const g = this.goneKeys.get(id);
    if (g) g.head = head;
  }
  /** A PR with this head branch was registered in this session for that repo (open, or since merged or closed). */
  knownHead(host: string, repo: string, head: string): boolean {
    const hit = (k: PrKey, h?: string) => h === head && sameRepo(k, { host, repo });
    return [...this.entries.values()].some((e) => hit(e.key, e.head)) || [...this.goneKeys.values()].some((g) => hit(g.key, g.head));
  }
  hosts(): string[] {
    return [...new Set([...this.entries.values()].map((e) => e.key.host.toLowerCase()).concat([...this.goneKeys.values()].map((g) => g.key.host.toLowerCase())))];
  }
  /** pr_untrack: drop it and keep it out of every automatic path. */
  untrack(key: PrKey): void {
    const id = keyString(key);
    this.entries.delete(id);
    this.goneKeys.delete(id);
    this.ignoredKeys.add(id);
  }
  isIgnored(key: PrKey): boolean {
    return this.ignoredKeys.has(keyString(key));
  }
  get size(): number {
    return this.entries.size;
  }
}

// ------------------------------------------------------------------ chains

export interface Segment {
  words: string[];
  /** Leading `NAME=value` words. */
  env: Record<string, string>;
  /** Raw source text of the segment. */
  text: string;
  /** Directory of the nearest earlier `cd <dir>` in the same command (as written). */
  cd: string | null;
  /** A `cd` this module cannot resolve (`~`, `$VAR`, `-`, no argument). */
  cdBad: boolean;
}

const REDIRECT = /^\d*(?:>>?|<|&>>?)/;

/** Quote-aware split on `&&`, `||`, `;`, `|`, a lone `&` and newlines; `cd <dir>` carries over to later segments. */
export function chainSegments(command: string): Segment[] {
  const parts: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (q) {
      cur += c;
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < command.length) cur += command[++i];
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
    } else if (c === "\\" && i + 1 < command.length) {
      cur += c + command[++i];
    } else if (c === "&" && (command[i - 1] === ">" || command[i + 1] === ">")) {
      cur += c;
    } else if (c === "&" || c === "|" || c === ";" || c === "\n" || c === "\r") {
      parts.push(cur);
      cur = "";
      if ((c === "&" || c === "|") && command[i + 1] === c) i++;
    } else cur += c;
  }
  parts.push(cur);
  const out: Segment[] = [];
  let cd: string | null = null;
  let cdBad = false;
  for (const text of parts) {
    const all = splitCommandLine(text.trim());
    if (!all) continue;
    const words: string[] = [];
    for (let i = 0; i < all.length; i++) {
      if (REDIRECT.test(all[i])) {
        if (/^\d*(?:>>?|<|&>>?)$/.test(all[i])) i++;
        continue;
      }
      words.push(all[i]);
    }
    const env: Record<string, string> = {};
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
      const w = words.shift() as string;
      env[w.slice(0, w.indexOf("="))] = w.slice(w.indexOf("=") + 1);
    }
    if (words.length === 0) continue;
    if (words[0] === "cd") {
      const d = words.length === 2 ? words[1] : null;
      const bad = d === null || d === "-" || /^~|\$/.test(d);
      if (!bad && cd !== null && !d.startsWith("/")) {
        cd = `${cd.replace(/\/+$/, "")}/${d}`;
      } else {
        cdBad = bad;
        cd = d;
      }
      continue;
    }
    out.push({ words, env, text: text.trim().slice(0, 4096), cd, cdBad: cd !== null && cdBad });
  }
  return out;
}

// ------------------------------------------------------------------ pushes

export interface PushCmd {
  remote: string | null;
  /** `-C` directories in order (composed by the caller). */
  dirs: string[];
  gitDir: boolean;
}

const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"]);
const PUSH_VALUE_OPTS = new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec", "--force-with-lease-x"]);

/** `git [global options] push …` (not `git stash push`), else null. */
export function parsePush(words: string[]): PushCmd | null {
  if (words[0] !== "git") return null;
  let i = 1;
  const dirs: string[] = [];
  let gitDir = false;
  while (i < words.length && words[i].startsWith("-")) {
    const w = words[i];
    if (w === "-C" && i + 1 < words.length) dirs.push(words[i + 1]);
    if (w === "--git-dir" || w.startsWith("--git-dir=") || w === "--work-tree" || w.startsWith("--work-tree=")) gitDir = true;
    i += GIT_VALUE_OPTS.has(w) ? 2 : 1;
  }
  if (words[i] !== "push") return null;
  let remote: string | null = null;
  for (let j = i + 1; j < words.length; j++) {
    const w = words[j];
    if (w.startsWith("-")) {
      if (PUSH_VALUE_OPTS.has(w)) j++;
      continue;
    }
    remote = w;
    break;
  }
  return { remote, dirs, gitDir };
}

const PUSH_LINE = /^\s*[ +*=!-]?\s*(\[new branch\]|[0-9a-f]{7,40}\.{2,3}[0-9a-f]{7,40})\s+\S+\s+->\s+(\S+)/;

/** Branch names a push printed as created or updated (tags, deletions, rejections and `up to date` are skipped). */
export function parsePushOutput(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = PUSH_LINE.exec(line);
    if (!m) continue;
    let dst = m[2];
    if (dst.startsWith("refs/heads/")) dst = dst.slice("refs/heads/".length);
    else if (dst.startsWith("refs/")) continue;
    if (dst && !out.includes(dst)) out.push(dst);
  }
  return out;
}

export interface Pushed {
  name: string;
  cwd: string;
  remote: string;
  at: number;
  repo: string;
  host: string;
  /** pr_find {head} runs made (0, 1 on the next tick, 2 five minutes later). */
  finds: number;
}

/** `git remote -v` hosts of a checkout (`[]` on any failure). */
export function remoteHostsOf(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("git", ["remote", "-v"], { cwd, timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      const hosts = new Set<string>();
      for (const line of String(stdout).split("\n")) {
        const url = line.split(/\s+/)[1] ?? "";
        const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([A-Za-z0-9.-]+)(?::\d+)?[:/]/.exec(url);
        if (m) hosts.add(m[1].toLowerCase());
      }
      resolve([...hosts]);
    });
  });
}

/** The checked-out branch when it has an upstream, else "" (the quiet-push fallback). */
export function branchWithUpstream(cwd: string): Promise<string> {
  const git = (args: string[]) => new Promise<string>((resolve) => execFile("git", args, { cwd, timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? "" : String(stdout).trim())));
  return git(["symbolic-ref", "--short", "-q", "HEAD"]).then(async (b) => (b && (await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${b}@{upstream}`])) ? b : ""));
}

// ------------------------------------------------------------------ interactions

/** A PR a command acted on; a missing `repo` or `host` means the current repository of the segment's directory. */
export interface Interaction {
  n: number;
  repo?: string;
  host?: string;
}

const GH_VERBS = new Set(["comment", "review", "checkout", "merge", "ready", "edit", "close", "reopen"]);
const GLAB_VERBS = new Set(["note", "approve", "checkout", "merge", "update", "close", "reopen"]);
const PR_VALUE_OPTS = new Set(["-R", "--repo", "-b", "--body", "-F", "--body-file", "-t", "--title", "-m", "--merge-method", "-B", "--base", "-m", "--message", "-r", "--reviewer", "-l", "--label", "-a", "--assignee", "--subject", "--author-email", "--match-head-commit"]);
const API_VALUE_OPTS = new Set(["-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field", "--input", "--hostname", "-q", "--jq", "-t", "--template", "--cache", "-p", "--preview"]);

function repoSpec(v: string | undefined): { repo?: string; host?: string } {
  if (!v) return {};
  const parts = v.split("/");
  if (parts.length === 3 && validHost(parts[0]) && validRepo(`${parts[1]}/${parts[2]}`)) return { host: parts[0], repo: `${parts[1]}/${parts[2]}` };
  return validRepo(v) ? { repo: v } : {};
}

function optionValue(words: string[], names: string[]): string | undefined {
  for (let i = 0; i < words.length; i++) {
    for (const n of names) {
      if (words[i] === n) return words[i + 1];
      if (n.startsWith("--") && words[i].startsWith(n + "=")) return words[i].slice(n.length + 1);
    }
  }
  return undefined;
}

function refOf(words: string[], from: number): string | undefined {
  for (let i = from; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith("-")) {
      if (PR_VALUE_OPTS.has(w)) i++;
      continue;
    }
    return w;
  }
  return undefined;
}

function fromRef(ref: string | undefined, words: string[], env: Record<string, string>): Interaction | null {
  if (!ref) return null;
  const url = parsePrUrl(ref);
  if (url) return { n: url.n, repo: url.repo, host: url.host };
  if (!/^\d{1,10}$/.test(ref) || !validNumber(Number(ref))) return null;
  const spec = repoSpec(optionValue(words, ["-R", "--repo"]) ?? env.GH_REPO);
  return { n: Number(ref), ...spec };
}

function apiPath(words: string[]): string | undefined {
  for (let i = 2; i < words.length; i++) {
    if (words[i].startsWith("-")) {
      if (API_VALUE_OPTS.has(words[i])) i++;
      continue;
    }
    return words[i];
  }
  return undefined;
}

/** Built-in forms: gh pr verbs, gh api write calls on issues/pulls, glab mr verbs. */
export function detectInteraction(seg: Pick<Segment, "words" | "env">): Interaction | null {
  const w = seg.words;
  if (w[0] === "gh" && w[1] === "pr" && GH_VERBS.has(w[2])) return fromRef(refOf(w, 3), w, seg.env);
  if (w[0] === "glab" && w[1] === "mr" && GLAB_VERBS.has(w[2])) return fromRef(refOf(w, 3), w, seg.env);
  if (w[0] === "gh" && w[1] === "api") {
    const method = (optionValue(w, ["-X", "--method"]) ?? "").toUpperCase();
    const implied = w.some((x) => ["-f", "-F", "--field", "--raw-field", "--input"].includes(x) || /^--(?:field|raw-field|input)=/.test(x));
    const write = method ? ["POST", "PATCH", "PUT"].includes(method) : implied;
    const p = apiPath(w);
    if (!write || !p) return null;
    const m = /^\/?repos\/([^/]+)\/([^/]+)\/(?:issues|pulls)\/(\d{1,10})(?:\/(?:comments|reviews|requested_reviewers))?(?:\?.*)?$/.exec(p);
    if (!m || !validNumber(Number(m[3]))) return null;
    const host = optionValue(w, ["--hostname"]) ?? undefined;
    const placeholder = (m[1] === "{owner}" && m[2] === "{repo}") || (m[1] === ":owner" && m[2] === ":repo");
    const out: Interaction = { n: Number(m[3]) };
    if (host && validHost(host)) out.host = host;
    if (!placeholder) {
      if (!validRepo(`${m[1]}/${m[2]}`)) return null;
      out.repo = `${m[1]}/${m[2]}`;
    } else if (seg.env.GH_REPO) Object.assign(out, repoSpec(seg.env.GH_REPO));
    return out;
  }
  return null;
}

/** `tools.prInteractions`: at most 16 `{pattern}` objects, each a regular expression of at most 200 characters (flag u). */
export function compilePatterns(list: unknown): RegExp[] {
  if (!Array.isArray(list)) return [];
  const out: RegExp[] = [];
  for (const item of list.slice(0, MAX_PATTERNS)) {
    const p = (item as { pattern?: unknown } | null)?.pattern;
    if (typeof p !== "string" || p.length === 0 || p.length > 200) continue;
    try {
      out.push(new RegExp(p, "u"));
    } catch {
      // an invalid pattern is skipped
    }
  }
  return out;
}

export function matchPatterns(patterns: RegExp[], text: string): Interaction | null {
  const t = text.slice(0, 4096);
  for (const re of patterns) {
    const g = re.exec(t)?.groups;
    if (!g?.n || !/^\d{1,10}$/.test(g.n) || !validNumber(Number(g.n))) continue;
    const spec = g.repo && validRepo(g.repo) ? { repo: g.repo } : {};
    const host = g.host && validHost(g.host) ? { host: g.host } : {};
    return { n: Number(g.n), ...spec, ...host };
  }
  return null;
}

// ------------------------------------------------------------------ events

/** An item of the user's events feed (from the shared watch snapshot). */
export interface Touched {
  host: string;
  repo: string;
  n: number;
  at: number | string;
}
export const TOUCHED_MAX_AGE_MS = 24 * 3600 * 1000;

/**
 * Register `touched` items with path `events` when their host and repo are the current repo's or a pushed
 * branch's repo and the item is younger than 24 h. Returns each registration's result for tracing.
 */
export function registerTouched(reg: PrRegistry, items: unknown, scope: { current: { host: string; repo: string } | null; pushed: { host: string; repo: string }[]; now: number }): Registered[] {
  if (!Array.isArray(items)) return [];
  const repos = [...(scope.current ? [scope.current] : []), ...scope.pushed.filter((p) => p.repo)];
  const out: Registered[] = [];
  for (const it of items.slice(0, 100)) {
    const t = it as Partial<Touched> | null;
    if (!t || !validHost(t.host) || !validRepo(t.repo) || !validNumber(t.n)) continue;
    const at = typeof t.at === "number" ? t.at : typeof t.at === "string" ? Date.parse(t.at) : NaN;
    if (!Number.isFinite(at) || scope.now - at > TOUCHED_MAX_AGE_MS) continue;
    if (!repos.some((r) => sameRepo(r, { host: t.host as string, repo: t.repo as string }))) continue;
    out.push(reg.register({ host: t.host, repo: t.repo, n: t.n }, "events"));
  }
  return out;
}
