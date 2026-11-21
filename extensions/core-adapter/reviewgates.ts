// The reviewer step per checkout (ceremony.reviewGate, docs/review.md "One review per revision"): each checkout of a session keeps its own `ReviewGate`
// (bound.ts), keyed by `toplevelOf` (reviews.ts), the key of `ReviewRecord.cwd` and the high-stakes runs. The key "" is the session-wide bucket: it holds an old
// saved gate and the verdicts of work whose checkout is unknown, and it behaves like today's single gate. Pure; index.ts wires it.
//
//   revise   a known checkout revises its own entry (an absent one is created as built, no review); an unknown checkout revises every entry.
//   verdict  known roots take the verdict each; a PASS also clears an existing "". An unknown root: a PASS clears "" only, a FAIL or no verdict hits every entry.
//   read     `gateOf`: the root's entry, else "" , else nothing yet; an unknown root reads `combined`. The finish gate reads `combined`: every entry must stand.
import * as path from "node:path";
import { initialReviewGate, onReviewVerdicts, onRevision, reopened, reviewHint, type ReviewGate } from "./bound.ts";
import type { Verdict } from "./rounds.ts";

export type ReviewGates = Record<string, ReviewGate>;

/** The session-wide bucket. */
export const SESSION_WIDE = "";

/** A PASS stands: the last verdict is PASS and nothing was revised since. */
export const stands = (g: ReviewGate): boolean => g.last === "pass" && !g.revised;

/** The entry of `root` (null = unknown checkout: all entries together); an unknown key reads the session-wide entry. */
export function gateOf(g: ReviewGates, root: string | null): ReviewGate {
  if (root === null) return combined(g);
  return g[root] ?? g[SESSION_WIDE] ?? initialReviewGate();
}

/** All entries as one gate: `last` is fail if any, else none, else null, else pass; `revised` any; `failAt` the max; `passRun` the newest entry's. Empty = initial. */
export function combined(g: ReviewGates): ReviewGate {
  const all = Object.values(g);
  if (all.length === 0) return initialReviewGate();
  const lasts = all.map((e) => e.last);
  const last: ReviewGate["last"] = lasts.includes("fail") ? "fail" : lasts.includes("none") ? "none" : lasts.includes(null) ? null : "pass";
  const failAts = all.map((e) => e.failAt).filter((x): x is number => x !== undefined);
  const passRun = [...all].reverse().find((e) => e.passRun)?.passRun;
  return { last, revised: all.some((e) => e.revised), ...(failAts.length > 0 ? { failAt: Math.max(...failAts) } : {}), ...(passRun ? { passRun } : {}), ...(all.some((e) => e.failed) ? { failed: true } : {}) };
}

/** Work happened in `root` (null = unknown checkout). */
export function gatesRevise(g: ReviewGates, root: string | null): ReviewGates {
  if (root === null) return Object.fromEntries(Object.entries(g).map(([k, e]) => [k, onRevision(e)]));
  return { ...g, [root]: g[root] ? onRevision(g[root]) : { last: null, revised: true } };
}

/** Reviews ended in `roots` (null = unknown; an empty list too); verdicts collapse as `onReviewVerdicts` (one non-pass wins). */
export function gatesVerdict(g: ReviewGates, roots: readonly string[] | null, verdicts: (Verdict | null)[], now?: number, runId?: string): ReviewGates {
  if (verdicts.length === 0) return g;
  const pass = !verdicts.includes("fail") && !verdicts.includes(null);
  const next: ReviewGates = { ...g };
  const apply = (k: string): void => {
    next[k] = onReviewVerdicts(g[k] ?? initialReviewGate(), verdicts, now, runId);
  };
  if (roots === null || roots.length === 0) {
    if (pass) apply(SESSION_WIDE);
    else for (const k of new Set([...Object.keys(g), SESSION_WIDE])) apply(k);
    return next;
  }
  for (const r of roots) apply(r);
  if (pass && g[SESSION_WIDE]) apply(SESSION_WIDE);
  return next;
}

/** A high-stakes FAIL was just written (`after`, from `before`): each entry now at FAIL records whether its PASS stood before the verdict; an entry that was revised or never passed stays open at the clear. */
export function gatesMarkStood(before: ReviewGates, after: ReviewGates): ReviewGates {
  const next: ReviewGates = { ...after };
  for (const [k, e] of Object.entries(after)) {
    if (e !== before[k] && e.last === "fail" && stands(gateOf(before, k))) next[k] = { ...e, stoodAtFail: true };
  }
  return next;
}

/**
 * A high-stakes FAIL (set at `failAt` on `keys`, null = every entry; no `failAt`: an old run, any FAIL entry) was cleared by a normal PASS: each of those entries still holding that FAIL (last verdict FAIL at `failAt`, no work since, and a PASS that stood before the FAIL: `stoodAtFail`)
 * passes too. An entry that took a later verdict or a revision is left as it is.
 */
export function gatesClearFail(g: ReviewGates, keys: string | null, failAt: number | undefined, now: number, runId?: string): ReviewGates {
  const next: ReviewGates = { ...g };
  for (const k of keys === null ? Object.keys(g) : [keys]) {
    const e = g[k];
    if (e && e.last === "fail" && !e.revised && e.stoodAtFail && (failAt === undefined || e.failAt === failAt)) next[k] = onReviewVerdicts(e, ["pass"], now, runId);
  }
  return next;
}

/** The keys of the entries that do not stand. */
export function openRoots(g: ReviewGates): string[] {
  return Object.entries(g).filter(([, e]) => !stands(e)).map(([k]) => k);
}

const reasonOf = (e: ReviewGate): string => {
  const why = reopened(e);
  if (why === "fail") return "last verdict FAIL";
  if (why === "revision") return e.last === "pass" ? "revised after the last PASS" : "revised after the last review";
  return e.last === null && e.revised ? "built, no review yet" : "no review yet";
};

/**
 * The refusal hint of the open entries. Exactly today's `reviewHint` when the only open key is the session's own checkout (`own`) or the session-wide one;
 * otherwise each open key with its path (relative to the session cwd when inside it, else the toplevel; "" is "unknown checkout") and its reason.
 */
export function openHint(g: ReviewGates, o: { cwd: string; own: string }): string {
  const open = openRoots(g);
  if (open.length === 0) return reviewHint(combined(g));
  if (open.length === 1 && (open[0] === SESSION_WIDE || open[0] === o.own)) return reviewHint(g[open[0]]);
  const name = (k: string): string => {
    if (k === SESSION_WIDE) return "unknown checkout";
    const rel = path.relative(o.cwd, k);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : k;
  };
  return `(re-review needed: ${open.map((k) => `${name(k)}: ${reasonOf(g[k])}`).join("; ")})`;
}

/** A key's entries that read as passed for `roots` (every root's gate stands): a launch there is a repeat. Null roots read `combined`. */
export function standsFor(g: ReviewGates, roots: readonly (string | null)[]): boolean {
  return roots.length > 0 && roots.every((r) => stands(gateOf(g, r)));
}
