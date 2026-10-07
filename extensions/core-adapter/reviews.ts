// Reviewer verdicts with the commit they covered (ledger 10-12): when a reviewer run ends with a
// verdict, HEAD of that run's cwd is recorded next to it. Only PASS heads open the PR gate
// (scripts/git_guard.py `pr_gate`, gitguard.ts). Trust level: role name + verdict token of the
// run-end event, as for the delegation rounds; a reviewer that ran in another checkout than the
// branch records another SHA, so the PR is refused (fail closed).
import { execFile } from "node:child_process";
import { REVIEW_ROLES, verdictOf } from "./rounds.ts";
import type { Verdict } from "./rounds.ts";

export interface ReviewRecord {
  role: string;
  verdict: Verdict;
  /** HEAD of the run's cwd when the verdict arrived; null when it could not be read. */
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
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "HEAD"], { cwd, timeout: HEAD_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      const sha = err ? "" : String(stdout).trim().toLowerCase();
      resolve(/^[0-9a-f]{40,64}$/.test(sha) ? sha : null);
    });
  });
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

export type PrRefusal = "no_review" | "stale_review" | "head_unknown";

/** The same SHA test the git guard applies, for a PR tool call: workspace HEAD against the reviewed heads. */
export async function prToolRefusal(cwd: string, reviewed: readonly string[]): Promise<{ reason: PrRefusal; message: string } | null> {
  const head = await headOf(cwd);
  if (head && reviewed.includes(head)) return null;
  const reason: PrRefusal = !head ? "head_unknown" : reviewed.length === 0 ? "no_review" : "stale_review";
  const why = { no_review: "no reviewer PASS is recorded in this session", stale_review: "the recorded reviewer PASS is for another commit than HEAD", head_unknown: "HEAD could not be resolved in the workspace" }[reason];
  return { reason, message: `pi-foreman: pull request creation refused [pr_refused:${reason}]: ${why}. Run a reviewer on this head (in the checkout the pull request comes from), then retry.` };
}

/** PR-creating package tool: a pr / pull_request / merge_request name part plus create or open. */
export function isPrToolName(name: string): boolean {
  return /(^|[_-])(pr|pull[_-]?request|merge[_-]?request)([_-]|$)/i.test(name) && /(create|open)/i.test(name);
}
