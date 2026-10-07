// Ceremony gate (plan D1, D2): what tier trivial lets the foreman change itself, and which
// child steps a standard or heavy session completes before the foreman may finish.
//
// D1 trivial bound (`ceremony.trivialBound`): a per-session tally of the foreman's own changes
// to project files (inside the workspace, outside `.workflow/`) through write, edit,
// foreman_move and foreman_copy: distinct files, changed lines (added + removed, as
// `git diff --numstat` counts them, from the tool arguments: edit oldText vs newText, write
// prior content vs new content, copy/move the source's lines) and new files. Checked before the
// call (pre-flight, the pending call included); a call that would cross the bound is refused,
// not counted, and the tier escalates to standard. A successful call adds to the tally at its
// tool result. Only `/ceremony` by the user resets it.
//
// D2 required steps (`ceremony.required.<tier>`): counted per session from the run-end events
// of runs this session launched (single, chain and tasks launches): planner = a planner run that
// completed; builder = a builder run that
// completed (not failed, timed out or stopped); reviewer = a reviewer or senior-reviewer run
// whose output has a verdict (PASS/FAIL, APPROVE/BLOCK); finalizer = a finalizer run that
// completed.
import * as fs from "node:fs";
import * as path from "node:path";
import { verdictOf, REVIEW_ROLES } from "./rounds.ts";

export interface TrivialBound {
  files: number;
  lines: number;
  newFiles: number;
}
export interface Tally {
  files: string[];
  lines: number;
  newFiles: number;
}
export type Change = Tally;

const DEFAULT_BOUND: TrivialBound = { files: 2, lines: 40, newFiles: 0 };

export function emptyTally(): Tally {
  return { files: [], lines: 0, newFiles: 0 };
}

export function readBound(v: unknown): TrivialBound {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const n = (k: keyof TrivialBound) => (typeof o[k] === "number" && Number.isInteger(o[k]) && (o[k] as number) >= 0 ? (o[k] as number) : DEFAULT_BOUND[k]);
  return { files: n("files"), lines: n("lines"), newFiles: n("newFiles") };
}

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Added + removed lines between two texts (LCS on lines; above ~4M cells the upper bound n + m). */
export function changedLines(before: string, after: string): number {
  const a = splitLines(before);
  const b = splitLines(after);
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ea = a.length;
  let eb = b.length;
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const x = a.slice(lo, ea);
  const y = b.slice(lo, eb);
  if (x.length === 0 || y.length === 0) return x.length + y.length;
  if (x.length * y.length > 4_000_000) return x.length + y.length;
  let prev = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array<number>(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  const lcs = prev[y.length];
  return x.length - lcs + (y.length - lcs);
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Files below a path (the path itself for a file), relative; capped. */
function filesBelow(p: string, cap = 2000): string[] {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return [];
  }
  if (!st.isDirectory()) return [""];
  const out: string[] = [];
  const walk = (rel: string) => {
    if (out.length >= cap) return;
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(p, rel));
    } catch {
      return;
    }
    for (const name of names) {
      const r = rel ? path.join(rel, name) : name;
      let s: fs.Stats;
      try {
        s = fs.lstatSync(path.join(p, r));
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(r);
      else if (out.length < cap) out.push(r);
    }
  };
  walk("");
  return out;
}

/**
 * The change a gated call would make. `inside` holds the absolute paths of the call's targets that
 * are project files (in the workspace, outside `.workflow/`); `abs` resolves a raw tool path.
 */
export function pendingChange(toolName: string, input: Record<string, unknown>, inside: Set<string>, abs: (raw: unknown) => string | null): Change {
  const files: string[] = [];
  let lines = 0;
  let newFiles = 0;
  if (toolName === "write" || toolName === "edit") {
    const p = abs(input.path ?? input.file_path ?? input.filePath);
    if (!p || !inside.has(p)) return emptyTally();
    files.push(p);
    if (toolName === "write") {
      const prior = readText(p);
      if (prior === null) newFiles++;
      lines = changedLines(prior ?? "", typeof input.content === "string" ? input.content : "");
    } else {
      const edits = Array.isArray(input.edits) ? input.edits : [input];
      for (const e of edits) {
        const o = e && typeof e === "object" ? (e as Record<string, unknown>) : {};
        lines += changedLines(typeof o.oldText === "string" ? o.oldText : "", typeof o.newText === "string" ? o.newText : "");
      }
    }
    return { files, lines, newFiles };
  }
  if (toolName === "foreman_copy" || toolName === "foreman_move") {
    const src = abs(input.src);
    const dst = abs(input.dst);
    if (!src || !dst) return emptyTally();
    const srcIn = toolName === "foreman_move" && inside.has(src);
    const dstIn = inside.has(dst);
    // A copy adds new files with their lines; a move inside the project is a rename (both paths
    // count as changed files, no lines, no new file). A move in from outside it adds them like a copy.
    const rename = toolName === "foreman_move" && srcIn;
    for (const rel of filesBelow(src)) {
      const s = rel ? path.join(src, rel) : src;
      if (srcIn) files.push(s);
      if (!dstIn) continue;
      files.push(rel ? path.join(dst, rel) : dst);
      if (rename) continue;
      newFiles++;
      lines += splitLines(readText(s) ?? "").length;
    }
  }
  return { files, lines, newFiles };
}

export function addChange(t: Tally, c: Change): Tally {
  return { files: [...t.files, ...c.files.filter((f, i) => !t.files.includes(f) && c.files.indexOf(f) === i)], lines: t.lines + c.lines, newFiles: t.newFiles + c.newFiles };
}

export function overBound(t: Tally, b: TrivialBound): boolean {
  return t.files.length > b.files || t.lines > b.lines || t.newFiles > b.newFiles;
}

export function boundRefusal(toolName: string, target: string, t: Tally, b: TrivialBound): string {
  return `pi-foreman: ${toolName} on '${target}' refused: at tier trivial the foreman changes at most ${b.files} files, ${b.lines} changed lines and ${b.newFiles} new files itself; with this call it would be ${t.files.length} files, ${t.lines} lines and ${t.newFiles} new files. The tier is now standard: write the ledger .workflow/LEDGER-<topic>.md and delegate the rest to a builder. Writes under .workflow/ stay open.`;
}

// ------------------------------------------------------------------ D2 required steps

export type Step = "planner" | "builder" | "reviewer" | "finalizer";
export type StepCounts = Record<Step, number>;

export function emptySteps(): StepCounts {
  return { planner: 0, builder: 0, reviewer: 0, finalizer: 0 };
}

/** `ceremony.required.<tier>` as a list of known steps (trivial: none). */
export function requiredSteps(configured: unknown, tier: string): Step[] {
  const v = configured && typeof configured === "object" ? (configured as Record<string, unknown>)[tier] : undefined;
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is Step => x === "planner" || x === "builder" || x === "reviewer" || x === "finalizer"))];
}

export function missingSteps(counts: StepCounts, required: Step[]): Step[] {
  return required.filter((s) => counts[s] < 1);
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Steps a run-end event (pi-subagents `subagent:async-complete` / `subagent:foreground-complete`)
 * counts: one entry per child result (`results[]`), else the run itself. A child counts as
 * completed only with status completed (or success true without a status) and no timeout,
 * stop or error.
 */
export function stepsOfRunEnd(data: unknown): Step[] {
  if (!isObj(data)) return [];
  const children = Array.isArray(data.results) && data.results.length > 0 ? data.results.filter(isObj) : [data];
  const out: Step[] = [];
  for (const c of children) {
    const agent = typeof c.agent === "string" ? c.agent : typeof data.agent === "string" ? data.agent : "";
    const completed = (c.status === undefined ? c.success === true : c.status === "completed") && c.success !== false && c.timedOut !== true && c.stopped !== true && !c.error;
    if (!completed) continue;
    if (agent === "planner") out.push("planner");
    else if (agent === "builder") out.push("builder");
    else if (agent === "finalizer") out.push("finalizer");
    else if (REVIEW_ROLES.includes(agent)) {
      const text = [c.output, c.summary].filter((t): t is string => typeof t === "string").join("\n");
      if (verdictOf(text) !== null) out.push("reviewer");
    }
  }
  return out;
}

export function finishRefusal(tier: string, missing: Step[]): string {
  return `pi-foreman: finish refused: tier ${tier} requires ${missing.join(", ")}; launch them or ask the owner to lower the tier with /ceremony.`;
}
