// PR sources (docs/tools.md#sources): `tools.prSources` names programs the PR tracker (`foreman prs poll`, prs-cli.ts) runs for each open PR it
// polled, to learn checks and comments GitHub does not have (an internal CI, a review bot). A source prints one JSON object (the wire format,
// parseWire); this module parses the config, runs one source for one PR and turns its answer into store runs and comments. Everything a source
// prints is untrusted data: fields are validated, token shapes redacted, control characters stripped, lengths cut. The program is found on PATH
// or by an absolute path; there is no shell, and a program under the agent state dir (the child's cwd) is refused.
import path from "node:path";
import { defaultStatusSpawner, resolveProgram, splitCommandLine } from "./extstatus.ts";
import type { StatusSpawner } from "./extstatus.ts";
import { globMatch, parseGlobs } from "./prwake.ts";
import type { CommentEntry, Run } from "./prwatch.ts";
import { redactCommand } from "./trace.ts";

export const MAX_SOURCES = 8;
export const DEFAULT_TIMEOUT_S = 20;
export const MIN_TIMEOUT_S = 5;
export const MAX_TIMEOUT_S = 120;
export const MAX_STDOUT = 256 * 1024;
const MAX_STDERR = 4 * 1024;
export const MAX_CHECKS = 50;
export const MAX_SOURCE_COMMENTS = 40;
const MAX_FIELD = 200;
const MAX_BODY = 500;
export const NO_ANSWER = "(no answer)";
export const SOURCE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const CONTROL = /[\p{Cc}\p{Cf}]/gu;

export interface SourceCfg {
  name: string;
  argv: string[];
  /** Globs over the lowercased `owner/name`; null: every repository. */
  repos: string[] | null;
  timeoutMs: number;
  /** true: its checks count toward "checks finished", "ready to merge" and "no checks". */
  gates: boolean;
}
export interface PrContext {
  host: string;
  repo: string;
  number: number;
  head: string;
  base: string;
}
export type SourceOutcome = "ok" | "failed" | "timeout" | "bad_output" | "program_missing" | "deadline";
export interface WireCheck {
  id: string;
  name: string;
  status: "pending" | "passed" | "failed";
  url: string;
}
export interface WireComment {
  id: string;
  kind: "issue" | "review" | "review_summary";
  author: string;
  bot: boolean;
  createdAt: number | null;
  body: string;
  path?: string;
  line?: number;
  state?: string;
}
export interface SourceResult {
  outcome: SourceOutcome;
  /** The first stderr line or a short cause, redacted; set unless outcome is ok. */
  error?: string;
  checks: WireCheck[];
  comments: WireComment[];
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const clean = (s: string): string => s.replace(CONTROL, "").trim();

/** The configured sources (at most 8, in key order) and one message per dropped or ignored entry. */
export function parsePrSources(raw: unknown): { sources: SourceCfg[]; errors: string[] } {
  const sources: SourceCfg[] = [];
  const errors: string[] = [];
  if (raw === undefined || raw === null) return { sources, errors };
  if (!isObj(raw)) return { sources, errors: ["tools.prSources must be an object"] };
  for (const [name, v] of Object.entries(raw)) {
    const at = `tools.prSources.${name.slice(0, 40)}`;
    if (name === "github" || !SOURCE_NAME.test(name)) {
      errors.push(`${at}: the name must match ${SOURCE_NAME.source} and not be github`);
      continue;
    }
    if (sources.length >= MAX_SOURCES) {
      errors.push(`${at}: only ${MAX_SOURCES} sources are used`);
      continue;
    }
    if (!isObj(v) || typeof v.command !== "string") {
      errors.push(`${at}: command (a string) is required`);
      continue;
    }
    const argv = splitCommandLine(v.command);
    if (!argv) {
      errors.push(`${at}: command is empty or has an open quote`);
      continue;
    }
    let repos: string[] | null = null;
    if (v.repos !== undefined) {
      const g = parseGlobs(v.repos, "repos");
      if (typeof g === "string") {
        errors.push(`${at}: ${g}`);
        continue;
      }
      repos = g.map((x) => x.toLowerCase());
    }
    const t = typeof v.timeoutSeconds === "number" && Number.isFinite(v.timeoutSeconds) ? v.timeoutSeconds : DEFAULT_TIMEOUT_S;
    sources.push({ name, argv, repos, timeoutMs: Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, t)) * 1000, gates: v.gates !== false });
  }
  return { sources, errors };
}

/** Does the source apply to `repo` (`owner/name`)? */
export const inScope = (cfg: SourceCfg, repo: string): boolean => cfg.repos === null || cfg.repos.some((g) => globMatch(g, repo.toLowerCase()));

const iso = (v: unknown): number | null => {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)$/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

const field = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = clean(v);
  return s.length >= 1 && s.length <= max ? s : null;
};

/** The checks and comments of a source's stdout, or null when the whole output is rejected. Unknown keys are dropped, invalid entries skipped. */
export function parseWire(stdout: string): { checks: WireCheck[]; comments: WireComment[] } | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  if (v.checks !== undefined && !Array.isArray(v.checks)) return null;
  if (v.comments !== undefined && !Array.isArray(v.comments)) return null;

  const named: { id: string | null; name: string; status: WireCheck["status"]; url: string }[] = [];
  for (const c of (v.checks as unknown[] | undefined) ?? []) {
    if (!isObj(c)) continue;
    const name = field(c.name, MAX_FIELD);
    const id = c.id === undefined ? null : field(c.id, MAX_FIELD);
    const status = c.status;
    if (name === null || (c.id !== undefined && id === null)) continue;
    if (status !== "pending" && status !== "passed" && status !== "failed") continue;
    if (name === NO_ANSWER || id === NO_ANSWER) continue;
    const url = typeof c.url === "string" && /^https:\/\/[^\s]+$/i.test(c.url) && c.url.length <= 500 && !CONTROL.test(c.url) ? c.url : "";
    CONTROL.lastIndex = 0;
    named.push({ id, name, status, url });
    if (named.length >= MAX_CHECKS) break;
  }
  // the index counts the checks of the same name and status before this one, so reordering never changes an id
  const ordinal = (c: (typeof named)[number], i: number): number => named.slice(0, i).filter((o) => o.name === c.name && o.status === c.status).length;
  const checks: WireCheck[] = named.map((c, i) => ({
    id: c.id ?? (named.some((o, j) => j !== i && o.name === c.name && o.status === c.status) ? `${c.name}@${c.status}#${ordinal(c, i)}` : `${c.name}@${c.status}`),
    name: c.name,
    status: c.status,
    url: c.url,
  }));

  const comments: WireComment[] = [];
  for (const c of (v.comments as unknown[] | undefined) ?? []) {
    if (!isObj(c)) continue;
    const id = field(c.id, MAX_FIELD);
    const author = field(c.author, 100);
    if (id === null || author === null) continue;
    if (c.kind !== "issue" && c.kind !== "review" && c.kind !== "review_summary") continue;
    const body = typeof c.body === "string" ? redactCommand(clean(c.body)).slice(0, MAX_BODY) : "";
    const o: WireComment = { id, kind: c.kind, author, bot: c.bot === true, createdAt: iso(c.createdAt), body };
    const p = field(c.path, 300);
    if (p !== null) o.path = p;
    if (typeof c.line === "number" && Number.isInteger(c.line) && c.line > 0) o.line = c.line;
    const st = field(c.state, 40);
    if (st !== null) o.state = st;
    comments.push(o);
  }
  // newest first; entries without a time keep their order after the dated ones
  const ordered = comments.map((c, i) => ({ c, i })).sort((a, b) => (b.c.createdAt ?? -Infinity) - (a.c.createdAt ?? -Infinity) || a.i - b.i).map((x) => x.c);
  return { checks, comments: ordered.slice(0, MAX_SOURCE_COMMENTS) };
}

export interface SourceRunDeps {
  /** The agent state dir: the child's cwd and the workspace the program must lie outside of. */
  stateDir: string;
  env: NodeJS.ProcessEnv;
  platform: string;
  spawner?: StatusSpawner;
}

const firstLine = (s: string): string => clean(s.split(/\r?\n/).find((l) => l.trim() !== "") ?? "");
const errorText = (s: string, fallback: string): string => redactCommand(firstLine(s) || fallback).slice(0, 200);

/** Run one source for one PR. Never throws. */
export async function runSource(cfg: SourceCfg, ctx: PrContext, deps: SourceRunDeps): Promise<SourceResult> {
  const fail = (outcome: SourceOutcome, error: string): SourceResult => ({ outcome, error, checks: [], comments: [] });
  const program = resolveProgram(cfg.argv[0], { workspace: deps.stateDir, env: deps.env, platform: deps.platform });
  if (!program) return fail("program_missing", "program not found, or not allowed (a .cmd or .bat file, or under the agent state dir)");
  const repl: Record<string, string> = { "{host}": ctx.host, "{repo}": ctx.repo, "{number}": String(ctx.number), "{head}": ctx.head, "{base}": ctx.base };
  const args = cfg.argv.slice(1).map((a) => repl[a] ?? a);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(deps.env)) if (typeof v === "string") env[k] = v;
  Object.assign(env, { PI_FOREMAN_PR_HOST: ctx.host, PI_FOREMAN_PR_REPO: ctx.repo, PI_FOREMAN_PR_NUMBER: String(ctx.number), PI_FOREMAN_PR_HEAD: ctx.head });
  const r = await (deps.spawner ?? defaultStatusSpawner)(program, args, { cwd: path.resolve(deps.stateDir), env, timeoutMs: cfg.timeoutMs, maxStdout: MAX_STDOUT, maxStderr: MAX_STDERR });
  if (r.timedOut) return fail("timeout", "timed out");
  if (r.overflow) return fail("bad_output", "output over 256 KB");
  if (r.error) return fail("program_missing", errorText(r.error.message, "could not start"));
  if (r.code !== 0) return fail("failed", errorText(r.stderr, `exit ${r.code}`));
  const wire = parseWire(r.stdout);
  return wire ? { outcome: "ok", ...wire } : fail("bad_output", "not a valid answer");
}

/** The source's checks as store runs of `head`; the id binds a failure to the commit it was seen on. */
export function sourceRuns(cfg: SourceCfg, head: string, checks: WireCheck[]): Run[] {
  const seen = new Set<string>();
  const runs: Run[] = [];
  for (const c of checks) {
    const id = `${cfg.name}:${head.slice(0, 12)}:${c.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    runs.push({ id, name: `${cfg.name}/${c.name}`, bucket: c.status, url: c.url, source: cfg.name, gates: cfg.gates });
  }
  return runs;
}

/** The tracker's own pending run for a counting source that did not answer. */
export const noAnswerRun = (cfg: SourceCfg): Run => ({ id: `${cfg.name}:${NO_ANSWER}`, name: `${cfg.name}/${NO_ANSWER}`, bucket: "pending", url: "", source: cfg.name, gates: true, noAnswer: true });

/** The source's comments as store comments. */
export function sourceComments(cfg: SourceCfg, comments: WireComment[]): CommentEntry[] {
  return comments.map((c) => {
    const e: CommentEntry = { id: `${cfg.name}:${c.id}`, kind: c.kind, author: c.author, body: c.body, source: cfg.name, bot: c.bot };
    if (c.path !== undefined) e.path = c.path;
    if (c.line !== undefined) e.line = c.line;
    if (c.state !== undefined) e.state = c.state;
    return e;
  });
}
