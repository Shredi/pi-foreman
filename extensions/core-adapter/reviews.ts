// Reviewer verdicts with the commit they covered (ledger 10-12): when a reviewer run ends with a
// verdict, HEAD of that run's cwd is recorded next to it, only when it equals HEAD at the run's
// launch (else null: a commit made during the review was not reviewed). Only PASS heads open the PR gate
// (scripts/git_guard.py `pr_gate`, gitguard.ts). Trust level: role name + verdict token of the
// run-end event, as for the delegation rounds; a reviewer that ran in another checkout than the
// branch records another SHA, so the PR is refused (fail closed).
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { REVIEW_ROLES, verdictOf } from "./rounds.ts";
import type { Verdict } from "./rounds.ts";

export interface ReviewRecord {
  role: string;
  verdict: Verdict;
  /** HEAD of the run's cwd at launch and at the verdict; null when they differ or could not be read. */
  head: string | null;
  /** Why head is null. */
  why?: NoHeadWhy;
}

export const MAX_REVIEWS = 50;
const HEAD_TIMEOUT_MS = 2000;

/** Completed reviewer results of a run-end event that carry a verdict, with the cwd they ran in. */
export function reviewsOfRunEnd(data: unknown): { role: string; verdict: Verdict; cwd: string | null }[] {
  return reviewsWithOutput(data).map(({ role, verdict, cwd }) => ({ role, verdict, cwd }));
}

/** As reviewsOfRunEnd, each with the path of the result's output file when it has one. */
export function reviewsWithOutput(data: unknown): { role: string; verdict: Verdict; cwd: string | null; outputPath?: string }[] {
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  const results = Array.isArray(d.results) && d.results.length > 0 ? d.results : [d];
  const out: { role: string; verdict: Verdict; cwd: string | null; outputPath?: string }[] = [];
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
    const ap = r.artifactPaths;
    const outputPath = ap && typeof ap === "object" ? (ap as Record<string, unknown>).outputPath : undefined;
    out.push({ role, verdict, cwd, ...(typeof outputPath === "string" && outputPath ? { outputPath } : {}) });
  }
  return out;
}

/** The verdict-file line for a review's head: `Head: <full sha>`, or `Head: unknown (<why>)` (docs/review.md, "Verdict file"). */
export function headLine(h: { head: string | null; why?: NoHeadWhy }): string {
  return h.head ? `Head: ${h.head}` : `Head: unknown (${h.why ?? "head_unread"})`;
}

/** Appends the Head line as the last line of an existing reviewer output file; false when the file is missing or not writable (it is never created). */
export function appendHeadLine(file: string, h: { head: string | null; why?: NoHeadWhy }): boolean {
  try {
    const cur = fs.readFileSync(file, "utf8");
    fs.appendFileSync(file, `${cur === "" || cur.endsWith("\n") ? "" : "\n"}${headLine(h)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** What the last `Head:` line of a verdict file names: the sha, "unknown", or null with no such line. The last line wins: the reviewer's own text may quote one. */
export function lastHeadLine(text: string): string | null {
  let last: string | null = null;
  for (const m of text.matchAll(/^Head: (?:([0-9a-f]{40,64})|unknown(?: \([a-z_]+\))?)[ \t]*\r?$/gm)) last = m[1] ?? "unknown";
  return last;
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
  return reviewedHeadWhy(start, cwd, end).head;
}

/** Why a review carries no head (the `why` of {@link reviewedHeadWhy}). */
export type NoHeadWhy = "no_launch_head" | "cwd_unmatched" | "head_moved" | "head_unread";
const NO_HEAD_WHY: readonly NoHeadWhy[] = ["no_launch_head", "cwd_unmatched", "head_moved", "head_unread"];

/** The spellings of a directory a start map may key it by: resolved and real path, case-folded on win32 only. */
function spellings(dir: string): string[] {
  const out = new Set<string>([path.resolve(dir)]);
  try {
    out.add(fs.realpathSync.native(dir));
  } catch {
    // not readable: the resolved spelling stands
  }
  return [...out].map((p) => (process.platform === "win32" ? p.toLowerCase() : p));
}

/** {@link reviewedHead} with the reason for a null head. */
export function reviewedHeadWhy(start: ReadonlyMap<string, string | null> | undefined, cwd: string, end: string | null): { head: string | null; why?: NoHeadWhy } {
  if (!start) return { head: null, why: "no_launch_head" };
  const want = new Set(spellings(cwd));
  let at: string | null | undefined;
  let found = false;
  for (const [k, v] of start) {
    if (!spellings(k).some((p) => want.has(p))) continue;
    at = v;
    found = true;
    break;
  }
  if (!found && start.size === 1) {
    at = [...start.values()][0];
    found = true;
  }
  if (!found) return { head: null, why: "cwd_unmatched" };
  if (!at) return { head: null, why: "no_launch_head" };
  if (!end) return { head: null, why: "head_unread" };
  return at === end ? { head: end } : { head: null, why: "head_moved" };
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

/**
 * Why the latest recorded verdict, a PASS, carries no head (`unknown` for a record restored without a reason); null when it
 * is not a headless PASS. The ledger's review gate takes such a PASS, the PR gate cannot, so a refusal names it.
 */
export function headlessPass(list: readonly ReviewRecord[]): string | null {
  const last = list[list.length - 1];
  return last && last.verdict === "pass" && last.head === null ? last.why ?? "unknown" : null;
}

/** Records of a persisted ceremony-state entry, validated field by field (bad ones dropped), newest MAX_REVIEWS kept. */
export function reviewsOfEntry(v: unknown): ReviewRecord[] {
  const out: ReviewRecord[] = [];
  if (!Array.isArray(v)) return out;
  for (const r of v as Record<string, unknown>[]) {
    if (!r || typeof r !== "object" || typeof r.role !== "string" || (r.verdict !== "pass" && r.verdict !== "fail")) continue;
    if (r.head !== null && !(typeof r.head === "string" && /^[0-9a-f]{40,64}$/.test(r.head))) continue;
    out.push({ role: r.role, verdict: r.verdict, head: r.head as string | null, ...(r.head === null && NO_HEAD_WHY.includes(r.why as NoHeadWhy) ? { why: r.why as NoHeadWhy } : {}) });
  }
  return out.slice(-MAX_REVIEWS);
}

/** Every `[pr_refused:<reason>]` the git guard (scripts/git_guard.py) and the PR tool gate emit. */
export const PR_REFUSALS = ["no_review", "stale_review", "head_unknown", "child", "pr_alias", "pr_compound", "pr_config", "checks_failed"] as const;
export type PrRefusal = "no_review" | "stale_review" | "head_unknown";

/** Arguments of a package PR tool that name the branch the pull request opens from (B-M7). */
export const PR_BRANCH_ARGS = ["head", "source_branch", "sourceBranch", "branch", "head_branch"];

/**
 * The reviewed-head test for one branch argument: null when accepted, else the refusal with the shas it names.
 * The PASS may be the branch's local ref, its remote-tracking ref (a push the local ref lags behind), its
 * upstream, or HEAD of the workspace (`cur`). A reviewed local ref whose upstream is another, unreviewed
 * commit is refused (B-M3).
 */
async function headRefusal(cwd: string, ref: string, reviewed: readonly string[], cur: string | null): Promise<{ reason: PrRefusal; passed: string; head: string } | null> {
  const head = await commitOf(cwd, ref);
  if (!head) return { reason: "head_unknown", passed: "", head: "" };
  const branch = ref === "HEAD" ? "" : ref;
  const up = await commitOf(cwd, branch + "@{upstream}");
  if (reviewed.includes(head) && up && !reviewed.includes(up)) return { reason: "stale_review", passed: head, head: up };
  const remote = branch ? await commitOf(cwd, "origin/" + branch) : null;
  if ([head, remote, up, cur].some((s) => s !== null && reviewed.includes(s))) return null;
  return { reason: reviewed.length === 0 ? "no_review" : "stale_review", passed: reviewed[reviewed.length - 1] ?? "", head };
}

/**
 * The same SHA test the git guard applies, for a PR tool call: each branch argument (`owner:branch`
 * reads as `branch`), else workspace HEAD, against the reviewed heads. A branch argument that does
 * not resolve in the workspace refuses (head_unknown).
 */
export async function prToolRefusal(cwd: string, reviewed: readonly string[], input: Record<string, unknown> = {}, headless: string | null = null): Promise<{ reason: PrRefusal; message: string } | null> {
  const named = PR_BRANCH_ARGS.filter((k) => input[k] !== undefined && input[k] !== null && input[k] !== "").map((k) => input[k]);
  const refs = named.length === 0 ? ["HEAD"] : named.map((v) => (typeof v === "string" ? v.split(":").pop() ?? "" : ""));
  const cur = await commitOf(cwd, "HEAD");
  for (const ref of refs) {
    const f = await headRefusal(cwd, ref, reviewed, cur);
    if (!f) continue;
    const unbound = `the latest reviewer PASS carries no commit (${headless}: HEAD changed while the reviewer ran, or its launch directory or checkout could not be matched or read), so it cannot open the gate`;
    const why = { no_review: headless ? unbound : "no reviewer PASS is recorded in this session", stale_review: headless ? unbound : `the recorded reviewer PASS is for another commit than this head (PASS ${f.passed}, head ${f.head})`, head_unknown: "the head could not be resolved in the workspace" }[f.reason];
    return { reason: f.reason, message: `pi-foreman: pull request creation refused [pr_refused:${f.reason}]: ${why}. Run a reviewer on this head (in the checkout the pull request comes from), then retry.` };
  }
  return null;
}

/** PR-creating package tool: a pr / mr / pull_request / merge_request name part (snake, kebab or camelCase) plus create or open. */
export function isPrToolName(name: string): boolean {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join("_");
  return /(^|_)(pr|mr|pull_?request|merge_?request)(_|$)/.test(words) && /(create|open)/.test(words);
}

/** The PR gate for a PR-creating tool call: children never, the review test when ceremony.reviewBeforePr is on. */
export async function prGateRefusal(g: { tool: string; isChild: boolean; gateOn: boolean; reviewed: readonly string[]; cwd: string; input?: Record<string, unknown>; headless?: string | null }): Promise<{ reason: string; message: string } | null> {
  if (g.isChild) return { reason: "child", message: `pi-foreman: ${g.tool} refused [pr_refused:child]: children may not create pull requests. Report back and let the foreman do it after a review.` };
  if (!g.gateOn) return null;
  return prToolRefusal(g.cwd, g.reviewed, g.input ?? {}, g.headless ?? null);
}

/** One line for the review panel block when the PR's checks failed ("" otherwise). */
export function checksLine(c: { failed: { name: string }[]; pending: unknown[]; summary: string } | null): string {
  if (!c || !Array.isArray(c.failed) || c.failed.length === 0) return "";
  return `PR checks: ${c.summary}. Failed checks block a merge; fix them before asking for review again.`;
}
