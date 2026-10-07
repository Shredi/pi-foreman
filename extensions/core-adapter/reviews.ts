// Reviewer verdicts with the commit they covered (ledger 10-12): when a reviewer run ends with a
// verdict, HEAD of that run's cwd is recorded next to it, only when it equals HEAD at the run's
// launch (else null: a commit made during the review was not reviewed). Only PASS heads open the PR gate
// (scripts/git_guard.py `pr_gate`, gitguard.ts). Trust level: role name + verdict token of the
// run-end event, as for the delegation rounds; a reviewer that ran in another checkout than the
// branch records another SHA, so the PR is refused (fail closed).
import { execFile } from "node:child_process";
import * as path from "node:path";
import { REVIEW_ROLES, verdictOf } from "./rounds.ts";
import type { Verdict } from "./rounds.ts";

export interface ReviewRecord {
  role: string;
  verdict: Verdict;
  /** HEAD of the run's cwd at launch and at the verdict; null when they differ or could not be read. */
  head: string | null;
}

export const MAX_REVIEWS = 50;
const HEAD_TIMEOUT_MS = 2000;

/** Completed reviewer results of a run-end event that carry a verdict, with the cwd they ran in. */
export function reviewsOfRunEnd(data: unknown): { role: string; verdict: Verdict; cwd: string | null }[] {
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  const results = Array.isArray(d.results) && d.results.length > 0 ? d.results : [d];
  const out: { role: string; verdict: Verdict; cwd: string | null }[] = [];
  for (const c of results) {
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    const role = typeof r.agent === "string" ? r.agent : typeof d.agent === "string" ? d.agent : "";
    if (!REVIEW_ROLES.includes(role)) continue;
    const completed = (r.status === undefined ? r.success === true : r.status === "completed") && r.success !== false && r.timedOut !== true && r.stopped !== true && !r.error;
    if (!completed) continue;
    const verdict = verdictOf([r.output, r.summary].filter((t): t is string => typeof t === "string").join("\n"));
    if (!verdict) continue;
    const cwd = typeof r.cwd === "string" && r.cwd ? r.cwd : typeof d.cwd === "string" && d.cwd ? d.cwd : null;
    out.push({ role, verdict, cwd });
  }
  return out;
}

/** `git rev-parse HEAD` in `cwd`; null on any failure. */
export function headOf(cwd: string): Promise<string | null> {
  return commitOf(cwd, "HEAD");
}

/** The commit `ref` names in `cwd`; null when it does not resolve (or looks like an option). */
export function commitOf(cwd: string, ref: string): Promise<string | null> {
  if (!ref || ref.startsWith("-")) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd, timeout: HEAD_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      const sha = err ? "" : String(stdout).trim().toLowerCase();
      resolve(/^[0-9a-f]{40,64}$/.test(sha) ? sha : null);
    });
  });
}

/** Directories a `subagent` launch may run in: the session cwd plus its own and each step's `cwd`, resolved. */
export function launchCwds(input: unknown, base: string): string[] {
  const out = new Set<string>([path.resolve(base)]);
  const visit = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.cwd === "string" && o.cwd) out.add(path.resolve(base, o.cwd));
    for (const k of ["tasks", "chain", "parallel"]) if (Array.isArray(o[k])) for (const step of o[k] as unknown[]) visit(step);
  };
  visit(input);
  return [...out];
}

/** HEAD of each directory when a reviewer run starts (B-M4). */
export async function headsAt(cwds: readonly string[]): Promise<Map<string, string | null>> {
  return new Map(await Promise.all(cwds.map(async (c) => [c, await headOf(c)] as [string, string | null])));
}

/**
 * The head a review is recorded for: HEAD at run end, kept only when it equals HEAD at run start
 * in the same directory (a commit made while the reviewer ran was not reviewed); null otherwise.
 * A start map of one directory stands for the run's cwd when the reported cwd is spelled differently.
 */
export function reviewedHead(start: ReadonlyMap<string, string | null> | undefined, cwd: string, end: string | null): string | null {
  if (!start || !end) return null;
  const at = start.has(path.resolve(cwd)) ? start.get(path.resolve(cwd)) : start.size === 1 ? [...start.values()][0] : null;
  return at === end ? end : null;
}

/** Map set that drops the oldest entries past `max` (launch heads whose run end never arrives). */
export function capSet<K, V>(m: Map<K, V>, k: K, v: V, max = MAX_REVIEWS): void {
  m.delete(k);
  m.set(k, v);
  for (const old of m.keys()) {
    if (m.size <= max) break;
    m.delete(old);
  }
}

export function appendReview(list: ReviewRecord[], rec: ReviewRecord): void {
  list.push(rec);
  if (list.length > MAX_REVIEWS) list.splice(0, list.length - MAX_REVIEWS);
}

/** Heads whose latest verdict is PASS, for the git guard's `pr_gate.reviewed_heads`. */
export function passHeads(list: readonly ReviewRecord[]): string[] {
  const last = new Map<string, Verdict>();
  for (const r of list) if (r.head) last.set(r.head, r.verdict);
  return [...last].filter(([, v]) => v === "pass").map(([h]) => h);
}

/** Every `[pr_refused:<reason>]` the git guard (scripts/git_guard.py) and the PR tool gate emit. */
export const PR_REFUSALS = ["no_review", "stale_review", "head_unknown", "child", "pr_alias", "pr_compound", "pr_config"] as const;
export type PrRefusal = "no_review" | "stale_review" | "head_unknown";

/** Arguments of a package PR tool that name the branch the pull request opens from (B-M7). */
export const PR_BRANCH_ARGS = ["head", "source_branch", "sourceBranch", "branch", "head_branch"];

/**
 * The same SHA test the git guard applies, for a PR tool call: each branch argument (`owner:branch`
 * reads as `branch`), else workspace HEAD, against the reviewed heads. A branch argument that does
 * not resolve in the workspace refuses (head_unknown).
 */
export async function prToolRefusal(cwd: string, reviewed: readonly string[], input: Record<string, unknown> = {}): Promise<{ reason: PrRefusal; message: string } | null> {
  const named = PR_BRANCH_ARGS.filter((k) => input[k] !== undefined && input[k] !== null && input[k] !== "").map((k) => input[k]);
  const heads = named.length === 0 ? [await headOf(cwd)] : await Promise.all(named.map((v) => (typeof v === "string" ? commitOf(cwd, v.split(":").pop() ?? "") : Promise.resolve(null))));
  let reason: PrRefusal | null = null;
  for (const head of heads) {
    if (head && reviewed.includes(head)) continue;
    reason = !head ? "head_unknown" : reviewed.length === 0 ? "no_review" : "stale_review";
    break;
  }
  if (!reason) return null;
  const why = { no_review: "no reviewer PASS is recorded in this session", stale_review: "the recorded reviewer PASS is for another commit than this head", head_unknown: "the head could not be resolved in the workspace" }[reason];
  return { reason, message: `pi-foreman: pull request creation refused [pr_refused:${reason}]: ${why}. Run a reviewer on this head (in the checkout the pull request comes from), then retry.` };
}

/** PR-creating package tool: a pr / mr / pull_request / merge_request name part (snake, kebab or camelCase) plus create or open. */
export function isPrToolName(name: string): boolean {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join("_");
  return /(^|_)(pr|mr|pull_?request|merge_?request)(_|$)/.test(words) && /(create|open)/.test(words);
}
