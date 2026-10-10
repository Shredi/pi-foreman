// Plan review ceremony (ceremony.planReview, docs/ceremony.md): at a tier where it is on, the plan
// checkpoint opens only after a primary `[plan-review]` verdict exists for the current plan bytes
// (sha1 of the file, taken when the review run ends and again when foreman_checkpoint is called).
// An edit changes the hash, so the earlier verdict no longer counts. A FAIL sends the plan back to
// the planner once (`plan_revision_required`); after the revised plan (a new hash) is reviewed again,
// the checkpoint opens whatever that verdict says, and the owner sees it in the dialog. The lineage
// is the real plan path, in memory for the session: a new plan path starts a new one.
// Plan reviews never mark items or feed gates (occasion.ts countsForItems).
import * as crypto from "node:crypto";
import * as path from "node:path";
import { CHECKPOINT_TOOL, PLAN_NAME } from "./checkpoint.ts";
import { ledgerLines } from "./ladder.ts";
import type { PanelFinding } from "./panel.ts";
import type { ReviewResult } from "./occasion.ts";
import type { Verdict } from "./rounds.ts";

export type PlanReviewRefusal = "plan_review_required" | "plan_revision_required";

/** Findings shown in the checkpoint dialog at most. */
export const PLAN_REVIEW_FINDINGS_MAX = 8;

export function planReviewHash(bytes: Buffer): string {
  return crypto.createHash("sha1").update(bytes).digest("hex");
}

/** Whether `ceremony.planReview.<tier>` is on (only an explicit true). */
export function planReviewOn(config: unknown, tier: string): boolean {
  const pr = config && typeof config === "object" ? (config as { ceremony?: { planReview?: Record<string, unknown> } }).ceremony?.planReview : undefined;
  return !!pr && typeof pr === "object" && pr[tier] === true;
}

export interface PlanVerdict {
  hash: string;
  verdict: Verdict;
  model: string | null;
  /** The located findings of the review (findings.ts), resolved after the run-end record call. */
  findings: Promise<PanelFinding[]>;
}

/** The primary plan-review results of a run end that carry a verdict. */
export function planReviewResults(results: readonly ReviewResult[]): (ReviewResult & { verdict: Verdict })[] {
  return results.filter((r): r is ReviewResult & { verdict: Verdict } => r.occasion === "plan-review" && r.primary && r.verdict !== null);
}

/** The plan files among a plan review's files (planReviewFiles); a bare name is taken from the scratch dir. */
export function planPathsOf(files: readonly string[], scratchDir: string): string[] {
  return files.filter((f) => PLAN_NAME.test(f.split(/[\\/]/).pop() ?? "")).map((f) => (/[\\/]/.test(f) ? f : path.join(scratchDir, f)));
}

/** Plan-review verdicts per plan lineage (real plan path). */
export class PlanReviews {
  private readonly byPath = new Map<string, { latest: PlanVerdict; firstFail: string | null }>();

  record(planPath: string, v: PlanVerdict): void {
    const l = this.byPath.get(planPath);
    const firstFail = l?.firstFail ?? (v.verdict === "fail" ? v.hash : null);
    this.byPath.set(planPath, { latest: v, firstFail });
  }

  /** The verdict that lets the checkpoint open, or why it is refused. */
  gate(planPath: string, hash: string): { verdict: PlanVerdict } | { refusal: PlanReviewRefusal; stale: boolean } {
    const l = this.byPath.get(planPath);
    if (!l || l.latest.hash !== hash) return { refusal: "plan_review_required", stale: !!l };
    if (l.latest.verdict === "fail" && l.firstFail === hash) return { refusal: "plan_revision_required", stale: false };
    return { verdict: l.latest };
  }
}

/** The refusal text of foreman_checkpoint. */
export function planReviewRefusalText(reason: PlanReviewRefusal, rel: string, tier: string, stale: boolean): string {
  const head = `pi-foreman: ${CHECKPOINT_TOOL} refused [${reason}]:`;
  if (reason === "plan_revision_required") {
    return `${head} the plan review of ${rel} failed. Send the plan back to the planner once with the review's findings, launch the reviewer with "[plan-review]" on the revised plan and the ledger, then call ${CHECKPOINT_TOOL} again; after that re-review the checkpoint opens whatever the verdict.`;
  }
  const why = stale ? "the plan changed since its last review, so that verdict no longer counts" : "the plan has no review yet";
  return `${head} at tier ${tier} the checkpoint needs a reviewer verdict on the current version of the plan (ceremony.planReview), and ${why}. Launch the reviewer with "[plan-review]" in its task, naming ${rel} and the ledger, wait for its verdict, then call ${CHECKPOINT_TOOL} again.`;
}

const one = (s: string): string => s.replace(/[\u0000-\u001f\u007f\u0080-\u009f]+/g, " ").trim().slice(0, 120);

/** The dialog section: verdict, reviewer model and the findings (file:line class note, at most PLAN_REVIEW_FINDINGS_MAX lines). */
export function planReviewSection(v: PlanVerdict, findings: readonly PanelFinding[]): string {
  const out = [`Plan review: ${v.verdict.toUpperCase()} (reviewer ${v.model ?? "unknown model"})`];
  for (const f of findings.slice(0, PLAN_REVIEW_FINDINGS_MAX)) out.push(`  ${one(f.file)}${f.line === null ? "" : `:${f.line}`} ${one(f.class)} ${one(f.note)}`.trimEnd());
  if (findings.length > PLAN_REVIEW_FINDINGS_MAX) out.push(`  (+${findings.length - PLAN_REVIEW_FINDINGS_MAX} more findings)`);
  if (findings.length === 0) out.push("  (no located findings)");
  return out.join("\n");
}

/** The facts block of a `[plan-review]` launch: the plan path and the bound ledger's open items, instead of a diff. */
export function planFactsBlock(plans: readonly string[], ledgerPath: string | null, ledger: string | null): string {
  const items = ledgerLines(ledger, "");
  return [
    "",
    "## Plan review facts (pi-foreman)",
    `Plan: ${plans.length ? plans.join(", ") : "(no plan-<topic>.md named in the task)"}`,
    `Ledger: ${ledgerPath ?? "(no ledger bound)"}`,
    "Open ledger items (review the plan against them: missing items, wrong order, risks):",
    ...(items.length ? items : ["(none)"]),
  ].join("\n");
}
