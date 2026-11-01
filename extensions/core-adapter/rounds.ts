// Revision rounds (H2, plan D3/D4): how often the builder may go back over reviewed work.
//
// What the adapter sees of a finished child: pi-subagents 0.75.0 delivers every detached
// completion to the foreman as a custom message `subagent-notify` (runs/background/notify.js
// sendCompletion), before the run that message triggers. Its first line is
// `Background task <status>: **<agent>**` (grouped: `Background tasks completed (n): **a**, **b**`),
// followed by the child's output preview. The verdict is read from that text: the reviewer's
// `Overall verdict: PASS|FAIL` and the senior reviewer's `Verdict: APPROVE|BLOCK`
// (agents/*.md output contracts). FAIL/BLOCK opens a round, PASS/APPROVE does not; with no
// verdict in the text (preview cut, contract not followed) the order alone counts.
//
// A builder run started while a review of built work is open is a revision round. Limit per
// tier: `ceremony.revisionRounds` (trivial 0). Every launch call is walked step by step
// (`launchSteps`): in a `chain`, each builder entry after a reviewer/senior-reviewer step counts
// as one round, and a call whose rounds would exceed the limit is refused as a whole. A review
// of built work counts as open from its launch until a PASS/APPROVE completion closes it, so a
// builder launched while that review is still running is a revision round too. A `resume` of a
// builder run counts like a builder launch (index.ts). Rounds reset on a user prompt and on a
// tier change by the user (`/ceremony`), not on a raise by the foreman, a ledger or a signal.
//
// Security exemption: a reviewer FAIL whose report has a finding line starting `SECURITY:` makes the
// builder launches that answer it (after that FAIL, up to the next review verdict) exempt from the
// limit. They still count toward a ceiling: exempt + counted revisions never exceed 2 x the limit.
//
// Chains: the count is kept per review chain (`RoundChains`), the key being the phase a launch's task names
// (`P2`, `phase 2`; a launch naming none stays on the current chain). A new phase starts at zero, so a limit reached
// in P1 does not block a P2 builder. A parent `ruling-*.md` with the line `revision-round: +1`, written after the
// refusal it answers (ctime), resets that chain's count once (`rulingReset`). The same scan with the `strict` options lifts the
// review cap and the read budgets for a parent `ruling-<n>.md` / `brief-<x>.md` (ruling.ts isCapsResetName, index.ts capsReset).

import * as fs from "node:fs";
import * as path from "node:path";
import type { Tier } from "./ceremony.ts";
import { isRulingName } from "./rulingname.ts";
import { isSubagentWakeText } from "./idlecustom.ts";
import { INTERCOM_WAKE_TEXT } from "./usage.ts";

const REVISION_LINE = /^revision-round:[ \t]*\+1[ \t]*$/m;

export const NOTIFY_TYPE = "subagent-notify";
export const REVIEW_ROLES = ["reviewer", "senior-reviewer"];
const DEFAULT_LIMITS: Record<Tier, number> = { trivial: 0, standard: 1, heavy: 2 };

export interface RoundState {
  /** A builder was launched since the last reset. */
  built: boolean;
  /** A review of built work was launched after the last builder launch and no PASS/APPROVE closed it. */
  reviewOpen: boolean;
  /** Revision rounds launched since the last reset. */
  used: number;
  /** The latest review verdict is a FAIL with a `SECURITY:` finding (cleared by the next verdict). Absent = false. */
  secOpen?: boolean;
  /** Security-exempt revision rounds launched since the last reset. Absent = 0. */
  exempt?: number;
  /** A revision builder answered the open FAIL (counted or exempt); cleared by the next verdict. Absent = false. */
  revisionAnswered?: boolean;
}

export type Verdict = "pass" | "fail";

export const DEFAULT_CHAIN = "main";

/** The phase key a launch call's task texts name (`P2`, `phase 2`), or `current` when none does. */
export function chainKey(input: Record<string, unknown>, current = DEFAULT_CHAIN): string {
  const texts: unknown[] = [input.task];
  for (const list of [input.tasks, input.chain]) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (!e || typeof e !== "object") continue;
      const o = e as Record<string, unknown>;
      texts.push(o.task, ...(Array.isArray(o.parallel) ? o.parallel.map((p) => (p && typeof p === "object" ? (p as Record<string, unknown>).task : undefined)) : []));
    }
  }
  for (const t of texts) {
    const m = typeof t === "string" ? /\bP(\d+)\b|\b[Pp]hase[ -]?(\d+)\b/.exec(t) : null;
    if (m) return `P${m[1] ?? m[2]}`;
  }
  return current;
}

export interface ResetOpts {
  /** Which file names count (default `isRulingName`). */
  names?: (name: string) => boolean;
  /** A line the file must hold (default `revision-round: +1`); null = none. */
  line?: RegExp | null;
  /** Regular files only (lstat, no symlink) and mtime newer than `afterMs` too (a chmod/mv changes only the ctime). */
  strict?: boolean;
}

/** A parent ruling in `dirs` with the line `revision-round: +1`, ctime newer than `afterMs` (the refusal) and not used yet. `at`: the later of its ctime and mtime. */
export function rulingReset(dirs: string[], afterMs: number, used: Set<string>, self?: { has(file: string, mtime: number): boolean }, opts: ResetOpts = {}): { file: string; id: string; at: number } | null {
  const line = opts.line === undefined ? REVISION_LINE : opts.line;
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
        if (!line || line.test(fs.readFileSync(file, "utf8"))) return { file, id, at: Math.max(st.ctimeMs, st.mtimeMs) };
      } catch {
        // vanished
      }
    }
  }
  return null;
}

/** The round state of the active review chain, the others set aside, and the last refusal (what a ruling must be newer than). */
export class RoundChains {
  key = DEFAULT_CHAIN;
  state: RoundState = initialRounds();
  refusal: { key: string; at: number } | null = null;
  private readonly saved = new Map<string, RoundState>();
  private readonly used = new Set<string>();

  /** Make `key` the active chain (its own state, a fresh one for a new phase). */
  enter(key: string): void {
    if (key === this.key) return;
    this.saved.set(this.key, this.state);
    this.state = this.saved.get(key) ?? initialRounds();
    this.saved.delete(key);
    this.key = key;
  }

  /** An owner prompt or tier change: every chain starts again. */
  clear(state: RoundState = initialRounds()): void {
    this.saved.clear();
    this.refusal = null;
    this.state = state;
  }

  /** Every chain's state, the active one included (the reload file, roundstate.ts). */
  all(): Map<string, RoundState> {
    return new Map([...this.saved, [this.key, this.state]]);
  }

  /** After a reload: `key` active, the other chains set aside; no refusal and no used ruling carry over. */
  restore(key: string, chains: Map<string, RoundState>): void {
    this.saved.clear();
    for (const [k, v] of chains) if (k !== key) this.saved.set(k, v);
    this.key = key;
    this.state = chains.get(key) ?? initialRounds();
    this.refusal = null;
  }

  /** After a refusal of the active chain: a fresh parent `revision-round: +1` ruling resets its count once. Returns the ruling file. */
  applyRuling(dirs: string[], self?: { has(file: string, mtime: number): boolean }): string | null {
    if (!this.refusal || this.refusal.key !== this.key) return null;
    const r = rulingReset(dirs, this.refusal.at, this.used, self);
    if (!r) return null;
    this.used.add(r.id);
    this.state = { ...this.state, used: 0, exempt: 0 };
    this.refusal = null;
    return r.file;
  }
}

export function initialRounds(): RoundState {
  return { built: false, reviewOpen: false, used: 0 };
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

// The reviewer's CRITIQUE block (agents/reviewer.md, agents/senior-reviewer.md): a `CRITIQUE:` line (`CRITIQUE: none`
// when empty), then `- [now] <text>` / `- [later] <text>` lines. It is advice and never part of a verdict.
const CRITIQUE_HEAD = /^\s*(?:[-*]\s+|\d+[.)]\s+)?\**CRITIQUE\**\s*:/i;
const CRITIQUE_LINE = /^\s*[-*]\s+\[(now|later)\]/i;

/** `text` without its CRITIQUE blocks (the head line and the `- [now|later]` lines and blank lines after it). */
export function withoutCritique(text: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    if (CRITIQUE_HEAD.test(line)) inBlock = true;
    else if (!(inBlock && (CRITIQUE_LINE.test(line) || !line.trim()))) inBlock = false;
    if (!inBlock) out.push(line);
  }
  return out.join("\n");
}

/** Counts of the `- [now]` and `- [later]` lines of a review's CRITIQUE blocks. */
export function critiqueOf(text: string): { now: number; later: number } {
  const c = { now: 0, later: 0 };
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    if (CRITIQUE_HEAD.test(line)) inBlock = true;
    else if (inBlock && CRITIQUE_LINE.test(line)) c[CRITIQUE_LINE.exec(line)![1].toLowerCase() as "now" | "later"]++;
    else if (line.trim()) inBlock = false;
  }
  return c;
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
  onReview(text: string, role: string, runId: string, lines?: number): Record<string, string | number> {
    const c = critiqueOf(text);
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

/** Verdict in a review's text: any FAIL/BLOCK wins, else PASS/APPROVE, else null. The CRITIQUE block does not count. */
export function verdictOf(text: string): Verdict | null {
  const all = [...withoutCritique(text).matchAll(/\b(?:overall\s+)?verdict\s*\**\s*:\s*\**\s*(pass|fail|approve|block)\b/gi)].map((m) => m[1].toLowerCase());
  if (all.some((v) => v === "fail" || v === "block")) return "fail";
  return all.length > 0 ? "pass" : null;
}

/** True when a review text has a finding line starting `SECURITY:` (after an optional list marker or bold). */
export function hasSecurityFinding(text: string): boolean {
  return /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?\**SECURITY:/m.test(text);
}

/**
 * Where a FAIL's SECURITY exemption comes from: the full reviewer report of the run end (`reportRun`, set when a counting
 * FAIL there carries a `SECURITY:` line), else the notice text (capped by pi-subagents at 2 000 characters). null: none.
 * `noticeIds`: the run ids the notice names; a flag of another run than those is stale and ignored (none named: the flag stands).
 */
export function securityOf(reportRun: string | null, notice: string, noticeIds: readonly string[] = []): "report" | "notice" | null {
  if (reportRun !== null && (noticeIds.length === 0 || noticeIds.includes(reportRun))) return "report";
  return hasSecurityFinding(notice) ? "notice" : null;
}

/**
 * True when a prompt is the owner's (revision chains start again): interactive and rpc always; an extension prompt unless it
 * is a harness text (the foreman's own `pi-foreman ...` steer and retro prompts, the subagent and intercom wakes, a
 * pi-subagents `Background task ...` notice).
 */
export function isOwnerPrompt(source: unknown, text: unknown): boolean {
  if (source === "interactive" || source === "rpc") return true;
  if (source !== "extension" || typeof text !== "string") return false;
  const t = text.trim();
  return !(t.startsWith("pi-foreman") || t.startsWith("Background task") || t.startsWith("<background-task-notification>") || isSubagentWakeText(t) || t === INTERCOM_WAKE_TEXT);
}

/** A review run finished. Only a review after a builder launch can open a round. `security`: the text carries a `SECURITY:` finding. */
export function onReviewDone(s: RoundState, verdict: Verdict | null, security = false): RoundState {
  if (!s.built) return s;
  const secOpen = verdict === "fail" && security;
  const { revisionAnswered: _answered, ...rest } = s;
  return { ...rest, reviewOpen: verdict !== "pass", ...(secOpen || s.secOpen ? { secOpen } : {}) };
}

export function revisionLimit(configured: unknown, tier: Tier): number {
  if (tier === "trivial") return 0;
  const v = configured && typeof configured === "object" ? (configured as Record<string, unknown>)[tier] : undefined;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : DEFAULT_LIMITS[tier];
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
  /** Builder runs in this call that are revision rounds (security-exempt ones included). */
  revisions: number;
  /** Of those, the ones that answer a `SECURITY:` finding and so do not count toward the limit. */
  exempt?: number;
  block?: string;
  /** Round state once the call is allowed. */
  next: RoundState;
}

/**
 * Walk a launch call's steps: each builder entry while a review is open is a revision round;
 * a review step after built work opens one. Refused when the call would exceed the tier's limit.
 */
export function checkLaunch(s: RoundState, steps: string[][], tier: Tier, configured: unknown, key = DEFAULT_CHAIN): LaunchRounds {
  let { built, reviewOpen } = s;
  let secOpen = s.secOpen === true;
  let counted = 0;
  let exempt = 0;
  for (const group of steps) {
    const builders = group.filter((a) => a === "builder").length;
    if (builders > 0) {
      if (reviewOpen) {
        if (secOpen) exempt += builders;
        else counted += builders;
      }
      built = true;
      reviewOpen = false;
    }
    if (built && group.some((a) => REVIEW_ROLES.includes(a))) {
      reviewOpen = true;
      secOpen = false; // the next verdict is another review's
    }
  }
  const revisions = counted + exempt;
  const usedExempt = (s.exempt ?? 0) + exempt;
  const next: RoundState = { built, reviewOpen, used: s.used + counted, ...(secOpen ? { secOpen } : {}), ...(usedExempt > 0 ? { exempt: usedExempt } : {}), ...(revisions > 0 || s.revisionAnswered ? { revisionAnswered: true } : {}) };
  const out = (block?: string): LaunchRounds => ({ revisions, ...(exempt > 0 ? { exempt } : {}), next, ...(block ? { block } : {}) });
  if (revisions === 0) return out();
  const limit = revisionLimit(configured, tier);
  const ceiling = 2 * limit;
  if (next.used <= limit && next.used + usedExempt <= ceiling) return out();
  const over = next.used <= limit;
  const note = usedExempt > 0 ? ` ${usedExempt} revision(s) answering a SECURITY finding were exempt from the limit but count toward the ceiling of ${ceiling} (2 x revisionRounds).` : "";
  return out(`pi-foreman: revision ${over ? "ceiling" : "limit"} for ${tier} reached (${over ? ceiling : limit}): this launch would bring the revision rounds to ${over ? next.used + usedExempt : next.used} (a builder run after a review, also one in the same chain or while a review is still running).${note} Report the open findings to the owner and ask how to go on; the owner can raise the tier with /ceremony. The count is kept per review chain (chain ${key}); it starts again (1) on a new user prompt (owner prompt), or (2) when the parent writes a ruling-<n>.md with the line \`revision-round: +1\` after this refusal (used once).`);
}

/** A tier change: only the user's own (`/ceremony`) starts the count again; a raise by the foreman, a ledger header or a signal does not. */
export function onTierChange(s: RoundState, source: string): RoundState {
  return source === "user" ? initialRounds() : s;
}
