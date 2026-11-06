// Foreman read budget (ceremony.foremanReads). Pure logic; index.ts
// wires it into tool_call / tool_result and keeps the state in memory only, per session.
//
// Read class: bash, read, grep, find, ls, codemode. A call counts by its distinct top-level
// call id: a nested codemode call `<outer>/<n>` maps to `<outer>`, so a script is one unit.
// Phase `before` lasts until the first child launch that started, `after` from the latest one;
// the count restarts at each started launch. The foreman's own reads are never refused: at `warn` the
// result carries a reminder to delegate, and again after every `every` further reads.


import { PACK_READ_TOOL_NAMES } from "./gitpack.ts";

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

/** `<outer>/<n>` -> `<outer>`. */
export function topLevelId(id: string): string {
  const i = id.indexOf("/");
  return i < 0 ? id : id.slice(0, i);
}

export type BudgetDecision =
  | { kind: "allow" }
  | { kind: "remind"; phase: Phase; count: number; text: string };

export class ReadBudget {
  phase: Phase = "before";
  private ids = new Set<string>();

  get count(): number {
    return this.ids.size;
  }

  /** Decide one tool call. `exempt`: supervisor reply window or a read of a recorded child result file. */
  check(toolName: string, toolCallId: string, limits: ReadLimits, exempt: boolean, coordination = false): BudgetDecision {
    if (!READ_CLASS.has(toolName) || exempt) return { kind: "allow" };
    const top = topLevelId(toolCallId);
    if (coordination || this.ids.has(top)) return { kind: "allow" };
    const n = this.ids.size + 1;
    const lim = limits[this.phase];
    this.ids.add(top);
    if (n >= lim.warn && (n - lim.warn) % lim.every === 0) {
      return { kind: "remind", phase: this.phase, count: n, text: `pi-foreman: you have read ${n} times; you should have enough to delegate: launch an explorer or builder for further exploration.` };
    }
    return { kind: "allow" };
  }

  /** A child launch recorded as started: the count restarts and the phase becomes `after`. */
  onLaunch(): void {
    this.phase = "after";
    this.ids = new Set();
  }

  /** A new user prompt: back to phase before with a fresh count. */
  resetAll(): number {
    const n = this.ids.size;
    this.phase = "before";
    this.ids = new Set();
    return n;
  }
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
