// Foreman read budgets (ceremony.foremanReads, ceremony.recheckBudget). Pure logic; index.ts
// wires it into tool_call / tool_result and keeps the state in memory only, per session.
//
// Read class: bash, read, grep, find, ls, codemode. A call counts by its distinct top-level
// call id: a nested codemode call `<outer>/<n>` maps to `<outer>`, so a script is one unit.
// Phase `before` lasts until the first child launch that started, `after` from the latest one;
// the count restarts at each started launch. The foreman's own reads are never refused: at `warn` the
// result carries a reminder to delegate, and again after every `every` further reads. Knob 2: after a reviewer PASS the foreman gets
// `recheckBudget` read-class calls, then is told to finish (the read budget does not apply).
// Finalization (R11 item 5): after a reviewer PASS, until the next started launch, the
// read budget never refuses and a plain git commit/add/status/log is exempt from both budgets while no child run
// is active (index.ts readBudgetCheck). After a reviewer PASS the coordination calls and the CI/merge steps of the reviewed head
// (`afterPassExempt`) do not count against `recheckBudget` either.


import { PACK_READ_TOOL_NAMES } from "./gitpack.ts";
import { parseShell } from "./shellast.ts";

export type Phase = "before" | "after";
export interface PhaseLimits {
  warn: number;
  every: number;
}
export type ReadLimits = Record<Phase, PhaseLimits>;

export const READ_CLASS: ReadonlySet<string> = new Set(["bash", "read", "grep", "find", "ls", "codemode", ...PACK_READ_TOOL_NAMES]);
/** A call that counts as a foreman read: READ_CLASS names, any MCP tool, and `subagent` get|guide (never a launch). */
export function isReadCall(name: string, input: unknown): boolean {
  if (READ_CLASS.has(name) || name.startsWith("mcp__")) return true;
  if (name !== "subagent" || !input || typeof input !== "object") return false;
  const action = (input as Record<string, unknown>).action;
  return action === "get" || action === "guide";
}
export const DEFAULT_READ_LIMITS: ReadLimits = { before: { warn: 8, every: 8 }, after: { warn: 8, every: 8 } };
export const DEFAULT_RECHECK = 3;
const MAX_FILES = 200;

const posInt = (v: unknown, min: number): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= min ? v : undefined);

/** `ceremony.foremanReads` with coded defaults for anything missing or malformed. */
export function readLimits(v: unknown): ReadLimits {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const one = (p: Phase): PhaseLimits => {
    const e = o[p] && typeof o[p] === "object" ? (o[p] as Record<string, unknown>) : {};
    return { warn: posInt(e.warn, 1) ?? DEFAULT_READ_LIMITS[p].warn, every: posInt(e.every, 1) ?? DEFAULT_READ_LIMITS[p].every };
  };
  return { before: one("before"), after: one("after") };
}

export function recheckLimit(v: unknown): number {
  return posInt(v, 0) ?? DEFAULT_RECHECK;
}

/** `<outer>/<n>` -> `<outer>`. */
export function topLevelId(id: string): string {
  const i = id.indexOf("/");
  return i < 0 ? id : id.slice(0, i);
}

export type BudgetDecision =
  | { kind: "allow" }
  | { kind: "remind"; phase: Phase; count: number; text: string }
  | { kind: "deny"; reason: string; event: "recheck_budget"; count: number };

export class ReadBudget {
  phase: Phase = "before";
  private ids = new Set<string>();
  private post: { ids: Set<string> } | null = null;
  private final = false;
  /** The latest review verdict (index.ts sets it from the review gate before each check); undefined keeps the default "the reviewer passed" text. */
  verdict?: "pass" | "fail" | "none" | null;

  /** Finalization: a reviewer PASS since the last started launch (index.ts adds: no child run active). */
  get finalized(): boolean {
    return this.final;
  }

  get count(): number {
    return this.ids.size;
  }
  get postPass(): boolean {
    return this.post !== null;
  }
  get recheckCount(): number {
    return this.post ? this.post.ids.size : 0;
  }

  /** Decide one tool call. `exempt`: supervisor reply window or a read of a recorded child result file. `afterPass`: a CI/merge step of the reviewed head ({@link afterPassExempt}); it never counts in the post-PASS window. */
  check(toolName: string, toolCallId: string, limits: ReadLimits, recheck: number, exempt: boolean, coordination = false, afterPass = false): BudgetDecision {
    if (!READ_CLASS.has(toolName) || exempt) return { kind: "allow" };
    const top = topLevelId(toolCallId);
    if (this.post) {
      if (coordination || afterPass || this.post.ids.has(top)) return { kind: "allow" };
      if (this.post.ids.size >= recheck) {
        return { kind: "deny", event: "recheck_budget", count: this.post.ids.size + 1, reason: this.recheckReason(recheck) };
      }
      this.post.ids.add(top);
      return { kind: "allow" };
    }
    if (coordination || this.ids.has(top)) return { kind: "allow" };
    const n = this.ids.size + 1;
    const lim = limits[this.phase];
    this.ids.add(top);
    if (n >= lim.warn && (n - lim.warn) % lim.every === 0) {
      return { kind: "remind", phase: this.phase, count: n, text: `pi-foreman: you have read ${n} times; you should have enough to delegate: launch an explorer or builder for further exploration.` };
    }
    return { kind: "allow" };
  }

  private recheckReason(recheck: number): string {
    const checks = `${recheck} own check${recheck === 1 ? "" : "s"}`;
    const head = "pi-foreman: [recheck_budget_exceeded]";
    if (this.verdict === "fail") return `${head} the last review FAILED; fix the failed items or report. You have used your ${checks} in this phase; do not keep checking.`;
    if (this.verdict === "none" || this.verdict === null) return `${head} no review is recorded yet; launch the reviewer or report. You have used your ${checks} in this phase; do not keep checking.`;
    return `${head} the reviewer passed; finish now. You have used your ${checks} after the pass; report the result instead of checking again.`;
  }

  /** A child launch recorded as started: the count restarts and the phase becomes `after`. */
  onLaunch(): void {
    this.phase = "after";
    this.final = false;
    this.ids = new Set();
  }

  /** A new user prompt: back to phase before with a fresh count (the post-PASS state is left separately). */
  resetAll(): number {
    const n = this.ids.size;
    this.phase = "before";
    this.ids = new Set();
    this.final = false;
    return n;
  }

  /** Reviewer PASS: enter the post-PASS state (knob 2). */
  enterPost(): void {
    this.post = { ids: new Set() };
    this.final = true;
  }

  /** Leave the post-PASS state; returns the checks used, or null when it was not active. */
  resetPost(): number | null {
    this.final = false;
    if (!this.post) return null;
    const n = this.post.ids.size;
    this.post = null;
    return n;
  }
}

// A word: allowed bare characters, single-quoted text without `'`, double-quoted text without `$`, backtick or `\`.
const FINAL_ARG = `(?:[A-Za-z0-9_./:=@%+,-]|'[^']*'|"[^"$\`\\\\]*")+`;
const FINAL_SEG = ` *git(?: +-C +${FINAL_ARG})? +(?:commit|add|status|log)(?: +${FINAL_ARG})* *`;
const FINAL_RE = new RegExp(`^${FINAL_SEG}(?:(?:&&|\\|\\||;|\\||\\n)${FINAL_SEG})*$`);

/**
 * A finalization command (R11 item 5): a bash command whose every segment is a plain `git commit|add|status|log`.
 * One allowlist regex, fail closed: outside quotes only `[A-Za-z0-9_./:=@%+,-]`, spaces and the separators `&&`,
 * `||`, `;`, `|` and newline; single quotes take anything but `'`, double quotes anything but `$`, backtick and `\`.
 * Anything else outside quotes (`$'…'`, `#`, `\`, a lone `&`, `<`, `>`, `(`, `)`, backticks, …) or an unclosed quote
 * never qualifies. Quoted text (a commit message) is not split.
 */
export function finalizationCommand(toolName: string, input: unknown): boolean {
  if (toolName !== "bash" || !input || typeof input !== "object") return false;
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== "string") return false;
  return FINAL_RE.test(command);
}

export interface AfterPassCtx {
  /** Heads whose latest review verdict is PASS (reviews.ts passHeads). */
  passHeads: readonly string[];
  /** HEAD and the branch name of the checkout the command runs in; null when unreadable. */
  head: string | null;
  branch: string | null;
}

const GIT_READ = new Set(["fetch", "rev-parse", "log", "status", "merge-tree"]);
const GH_READ = new Set(["pr checks", "pr view", "run list", "run view", "run watch"]);
const PIPE_TAIL = new Set(["head", "tail", "wc", "sleep", "echo", "true"]);
const MERGE_FLAGS = new Set(["--squash", "--merge", "--rebase", "--delete-branch", "--auto", "-s", "-m", "-r", "-d"]);
const API_WRITE = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function pushOk(args: string[], c: AfterPassCtx): boolean {
  if (!c.head || !c.passHeads.includes(c.head)) return false;
  const pos: string[] = [];
  for (const a of args) {
    if (a === "-u" || a === "--set-upstream") continue;
    if (a.startsWith("-")) return false;
    pos.push(a);
  }
  if (pos.length === 0) return true;
  if (pos[0] !== "origin" || pos.length > 2) return false;
  return pos.length === 1 || pos[1] === "HEAD" || (c.branch !== null && pos[1] === c.branch);
}

function mergeOk(args: string[], c: AfterPassCtx): boolean {
  let sha: string | null = null;
  let pr = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--match-head-commit") sha = args[++i] ?? null;
    else if (a.startsWith("--match-head-commit=")) sha = a.slice(a.indexOf("=") + 1);
    else if (a.startsWith("-")) {
      if (!MERGE_FLAGS.has(a)) return false;
    } else if (++pr > 1) return false;
  }
  return sha !== null && FULL_SHA.test(sha) && c.passHeads.includes(sha);
}

function apiOk(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (API_WRITE.has(a) || /^-[fF]./.test(a) || /^--(?:field|raw-field|input)=/.test(a)) return false;
    const m = a === "-X" || a === "--method" ? args[++i] : /^--method=(.*)$/.exec(a)?.[1] ?? (/^-X(.+)$/.exec(a)?.[1]);
    if (m !== undefined && m.toUpperCase() !== "GET") return false;
  }
  return true;
}

/**
 * Post-PASS exemption (ceremony.recheckBudget): a bash command whose every segment is a read-only CI or merge step of the
 * reviewed head and so no re-check: `git push` of a PASS head (no force, no other refspec), `gh pr merge <n>` with
 * `--match-head-commit <full PASS head>`, `gh pr checks|view`, `gh run list|view|watch`, a GET-only `gh api`, and
 * `git fetch|rev-parse|log|status|merge-tree`. Parsed with parseShell; an opaque segment, a redirect to a file or any other
 * program never qualifies. A command that changes HEAD still leaves the review stale (the sha-based PR gate).
 */
export function afterPassExempt(command: string, c: AfterPassCtx): boolean {
  const segs = parseShell(command);
  if (segs.length === 0) return false;
  let ok = false;
  for (const s of segs) {
    if (s.opaque || s.heredoc || s.redirects.some((r) => r.op !== "dup")) return false;
    if (s.program === "cd" || PIPE_TAIL.has(s.program)) continue;
    let argv = s.argv;
    if (s.program === "git") {
      if (argv[0] === "-C" && argv.length > 2) argv = argv.slice(2);
      const sub = argv[0];
      if (sub === "push" ? pushOk(argv.slice(1), c) : GIT_READ.has(sub)) ok = true;
      else return false;
    } else if (s.program === "gh") {
      const sub = `${argv[0]} ${argv[1]}`;
      if (argv[0] === "api" ? apiOk(argv.slice(1)) : sub === "pr merge" ? mergeOk(argv.slice(2), c) : GH_READ.has(sub)) ok = true;
      else return false;
    } else return false;
  }
  return ok;
}

const PR_COORDINATION: ReadonlySet<string> = new Set(["pr_status", "pr_checks", "pr_comments", "pr_watch", "pr_unwatch"]);
const FOREMAN_SESSION_SEG = /^(?:\S*\/)?foreman session(?:\s|$)/;
const CD_SEG = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*$/;

/**
 * A coordination call, not a read of the project: a PR status tool, or a bash command whose every command is
 * `foreman session ...` (`bin/foreman session ...` too), after an optional leading `cd <dir> &&`. Command substitution
 * never qualifies.
 */
export function coordinationCall(toolName: string, input: unknown): boolean {
  if (PR_COORDINATION.has(toolName)) return true;
  if (toolName !== "bash" || !input || typeof input !== "object") return false;
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== "string" || /\$\(|`/.test(command)) return false;
  const segs = command.split(/&&|\|\||;|\||\n/).map((s) => s.trim());
  if (segs.length > 1 && CD_SEG.test(segs[0])) segs.shift();
  return segs.length > 0 && segs.every((s) => FOREMAN_SESSION_SEG.test(s));
}

// Child result locations: taken only from structured places, never from free text (a child's
// output, a file:line reference, an error message). A location is a result file or a run's async
// directory; a read of it or of a file under it (the run's output and status files) is exempt.
const isAbs = (p: unknown): p is string => typeof p === "string" && /^(?:[A-Za-z]:[\\/]|\/)/.test(p) && !p.includes("\n");
const lastSegment = (p: string): string | undefined => p.split(/[\\/]/).filter(Boolean).pop();

/** `details.asyncDir` and `details.resultPath` of a started launch's result. */
export function detailLocations(details: unknown): string[] {
  if (!details || typeof details !== "object") return [];
  const d = details as Record<string, unknown>;
  return [d.asyncDir, d.resultPath].filter(isAbs);
}

/**
 * A started launch's own run, recorded at launch: `details.asyncDir`/`resultPath` and the run dir
 * `<uidRoot>/async-subagent-runs/<id>` for each "Async: <agent> [<id>]" line (`uidRoot` = `<tmp>/pi-subagents-uid-<uid>`; null = no such guess).
 */
export function launchLocations(text: string, details: unknown, uidRoot: string | null): string[] {
  const out = detailLocations(details);
  if (uidRoot && isAbs(uidRoot)) {
    for (const m of text.matchAll(/^Async: .+ \[([A-Za-z0-9_.-]+)\]\s*$/gm)) if (m[1] !== "." && m[1] !== "..") out.push(`${uidRoot.replace(/[\\/]+$/, "")}/async-subagent-runs/${m[1]}`);
  }
  return out;
}

/** A completion notice's "Retention-managed async directory:" lines whose last segment is a run id `known` accepts. */
export function noticeLocations(text: string, known: (runId: string) => boolean): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^Retention-managed async directory: (.+)$/gm)) {
    const dir = m[1].trim();
    const id = lastSegment(dir);
    if (isAbs(dir) && id && known(id)) out.push(dir);
  }
  return out;
}

/** A bg_wait result's "Result [<id>]: <path>" lines for run ids `known` accepts. */
export function bgWaitLocations(text: string, known: (runId: string) => boolean): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^Result \[([^\]\s]+)\]: (.+)$/gm)) {
    const p = m[2].trim();
    if (known(m[1]) && isAbs(p)) out.push(p);
  }
  return out;
}

/** True when `file` is a recorded location or lies below one (both normalised the same way). */
export function inRecorded(files: ReadonlySet<string>, file: string): boolean {
  if (files.has(file)) return true;
  for (const loc of files) {
    const base = loc.replace(/[\\/]+$/, "");
    if (file.startsWith(`${base}/`) || file.startsWith(`${base}\\`)) return true;
  }
  return false;
}

/**
 * Remember locations, newest kept, at most MAX_FILES. A location that is `cwd` or contains it is
 * skipped (it would exempt every project file).
 */
export function recordFiles(files: Set<string>, paths: string[], normalise: (p: string) => string, cwd?: string): void {
  const home = cwd ? normalise(cwd) : undefined;
  for (const raw of paths) {
    const p = normalise(raw);
    if (home && inRecorded(new Set([p]), home)) continue;
    files.delete(p);
    files.add(p);
    if (files.size > MAX_FILES) files.delete(files.values().next().value as string);
  }
}
