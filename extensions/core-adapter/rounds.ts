// Review rounds (H2, plan D3/D4): when a builder launch is a revision of reviewed work. No count stops it; the loop guard
// (reviewloop.ts) does.
//
// What the adapter sees of a finished child: pi-subagents 0.75.0 delivers every detached
// completion to the foreman as a custom message `subagent-notify` (runs/background/notify.js
// sendCompletion), before the run that message triggers. Its first line is
// `Background task <status>: **<agent>**` (grouped: `Background tasks completed (n): **a**, **b**`),
// followed by the child's output preview. The verdict is not read from that text: it comes from the reviewer's `review_verdict`
// record (verdict.ts). FAIL opens a round, PASS does not; with no record the order alone counts.
//
// A builder run started while a review of built work is open is a revision round (the ladder's revision climb reads it).
// Every launch call is walked step by step (`launchSteps`): in a `chain`, each builder entry after a reviewer step is one
// revision. A review of built work counts as open from its launch until a PASS completion closes it, so a
// builder launched while that review is still running is a revision too. A `resume` of a
// builder run counts like a builder launch (index.ts). The state resets on a user prompt and on a
// tier change by the user (`/ceremony`), not on a raise by the foreman, a ledger or a signal.
//
// `rulingReset` with the `strict` options lifts the loop stop and the read budget for a parent
// `brief-<x>.md` (ruling.ts isCapsResetName, index.ts capsReset).

import * as fs from "node:fs";
import * as path from "node:path";
import { isRulingName } from "./rulingname.ts";
import { isSubagentWakeText } from "./idlecustom.ts";
import { INTERCOM_WAKE_TEXT } from "./usage.ts";

export const NOTIFY_TYPE = "subagent-notify";
export const REVIEW_ROLES = ["reviewer"];

export interface RoundState {
  /** A builder was launched since the last reset. */
  built: boolean;
  /** A review of built work was launched after the last builder launch and no PASS/APPROVE closed it. */
  reviewOpen: boolean;
  /** A revision builder answered the open FAIL; cleared by the next verdict. Absent = false. */
  revisionAnswered?: boolean;
}

export type Verdict = "pass" | "fail";

export interface ResetOpts {
  /** Which file names count (default `isRulingName`). */
  names?: (name: string) => boolean;
  /** Regular files only (lstat, no symlink) and mtime newer than `afterMs` too (a chmod/mv changes only the ctime). */
  strict?: boolean;
}

/** A parent ruling or brief in `dirs` with a ctime newer than `afterMs` and not used yet. `at`: the later of its ctime and mtime. */
export function rulingReset(dirs: string[], afterMs: number, used: Set<string>, self?: { has(file: string, mtime: number): boolean }, opts: ResetOpts = {}): { file: string; id: string; at: number } | null {
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter(opts.names ?? isRulingName);
    } catch {
      continue;
    }
    for (const n of names) {
      const file = path.join(dir, n);
      try {
        const st = opts.strict ? fs.lstatSync(file) : fs.statSync(file);
        const id = `${file}:${st.ctimeMs}`;
        if (opts.strict && (!st.isFile() || st.mtimeMs <= afterMs)) continue;
        if (st.ctimeMs <= afterMs || used.has(id) || self?.has(file, st.mtimeMs)) continue;
        return { file, id, at: Math.max(st.ctimeMs, st.mtimeMs) };
      } catch {
        // vanished
      }
    }
  }
  return null;
}

export function initialRounds(): RoundState {
  return { built: false, reviewOpen: false };
}

/** Agents a completion notice reports as completed, or [] when the text is not one. */
export function completedAgents(content: string): string[] {
  const first = content.split(/\r?\n/, 1)[0] ?? "";
  const single = /^(?:Background task|Detached foreground task) (completed|failed|paused|stopped): \*\*(.+?)\*\*/.exec(first);
  if (single) return single[1] === "completed" ? [single[2]] : [];
  const grouped = /^Background tasks completed \(\d+\): (.*)$/.exec(first);
  if (!grouped) return [];
  return [...grouped[1].matchAll(/\*\*(.+?)\*\*/g)].map((m) => m[1]);
}

/** Counts of the findings of kind `now` and `later` in a review's verdict record (advice; it never makes a FAIL). */
export function critiqueOf(findings: readonly { kind: string }[]): { now: number; later: number } {
  return { now: findings.filter((f) => f.kind === "now").length, later: findings.filter((f) => f.kind === "later").length };
}

/**
 * Retro counter (docs/retro.md "Critique counter"), one round per counted review run: `critique {kind: raised, count,
 * lines}` at its run end (`count` = its `[now]` + `[later]` lines, `lines` = changed lines of the diff it reviewed), and
 * `critique {kind: applied, count}` at the next builder launch before the next counted review (`count` = that review's
 * `[now]` lines, which the foreman sends back in that revision). A later review replaces unsent `now` lines.
 */
export class CritiqueCounter {
  private now = 0;

  /** A counted review run ended: its `raised` record. */
  onReview(findings: readonly { kind: string }[], role: string, runId: string, lines?: number): Record<string, string | number> {
    const c = critiqueOf(findings);
    this.now = c.now;
    return { event: "critique", kind: "raised", role, runId, count: c.now + c.later, ...(lines !== undefined ? { lines } : {}) };
  }

  /** A builder launch passed every check: the `applied` record when the last review left `now` lines, else null. */
  onBuilder(): Record<string, string | number> | null {
    const count = this.now;
    this.now = 0;
    return count > 0 ? { event: "critique", kind: "applied", role: "builder", count } : null;
  }
}

/**
 * True when a prompt is the owner's (the round state and the loop stop start again): interactive and rpc always; an extension prompt unless it
 * is a harness text (the foreman's own `pi-foreman ...` steer and retro prompts, the subagent wake, the legacy intercom
 * wake line of Pi < 1.2.0, a pi-subagents `Background task ...` notice). Pi 1.2+ starts an inbound intercom run without
 * an `input` event, so it never reaches this check.
 */
export function isOwnerPrompt(source: unknown, text: unknown): boolean {
  if (source === "interactive" || source === "rpc") return true;
  if (source !== "extension" || typeof text !== "string") return false;
  const t = text.trim();
  return !(t.startsWith("pi-foreman") || t.startsWith("Background task") || t.startsWith("<background-task-notification>") || isSubagentWakeText(t) || t === INTERCOM_WAKE_TEXT);
}

/** A review run finished. Only a review after a builder launch can open a round. */
export function onReviewDone(s: RoundState, verdict: Verdict | null): RoundState {
  if (!s.built) return s;
  const { revisionAnswered: _answered, ...rest } = s;
  return { ...rest, reviewOpen: verdict !== "pass" };
}

type Json = Record<string, unknown>;

/** The agents of one launch call in run order; the agents of one inner list run at the same time. */
export function launchSteps(input: Json): string[][] {
  const names = (list: unknown[]): string[] => list.map((e) => (e && typeof e === "object" ? (e as Json).agent : undefined)).filter((a): a is string => typeof a === "string" && a !== "");
  const steps: string[][] = [];
  if (typeof input.agent === "string" && input.agent) steps.push([input.agent]);
  if (Array.isArray(input.tasks)) steps.push(names(input.tasks));
  if (Array.isArray(input.chain)) {
    for (const step of input.chain) {
      if (!step || typeof step !== "object") continue;
      const st = step as Json;
      steps.push(Array.isArray(st.parallel) ? names(st.parallel) : names([st]));
    }
  }
  return steps.filter((g) => g.length > 0);
}

export interface LaunchRounds {
  /** Builder runs in this call that are revision rounds. */
  revisions: number;
  /** Round state once the call is allowed. */
  next: RoundState;
}

/**
 * Walk a launch call's steps: each builder entry while a review is open is a revision round;
 * a review step after built work opens one. Nothing is refused here.
 */
export function walkLaunch(s: RoundState, steps: string[][]): LaunchRounds {
  let { built, reviewOpen } = s;
  let revisions = 0;
  for (const group of steps) {
    const builders = group.filter((a) => a === "builder").length;
    if (builders > 0) {
      if (reviewOpen) revisions += builders;
      built = true;
      reviewOpen = false;
    }
    if (built && group.some((a) => REVIEW_ROLES.includes(a))) reviewOpen = true;
  }
  return { revisions, next: { built, reviewOpen, ...(revisions > 0 || s.revisionAnswered ? { revisionAnswered: true } : {}) } };
}
