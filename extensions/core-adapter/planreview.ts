// Plan review ceremony (ceremony.planReview, docs/ceremony.md): at a tier where it is on, the plan
// checkpoint opens only after a primary `[plan-review]` verdict exists for the current plan bytes
// (the plan VERSION hash, checkpoint.ts planVersionHash: sha256 of the body above any ruling /
// decision-log / addendum appendix; taken when the review run ends and again when foreman_checkpoint
// is called). A body edit is a new version, so the earlier verdict no longer counts; an appended
// ruling is not and needs no new review.
// `planReviewHash` (sha1 of the whole file) is kept for callers that want the byte hash. A FAIL sends the plan back for
// a revision (`plan_revision_required`); the session revises and has the new version reviewed until it
// passes. The checkpoint opens on a verdict for the current version at the round cap below, with a FAIL
// for findings that need a decision, and the owner sees it in the dialog. The lineage
// is the real plan path, in memory for the session: a new plan path starts a new one.
// `ceremony.planReviewRounds` (default 2) generalises that: each recorded verdict is a round of its
// lineage; a FAIL before the cap goes back for a revision, a FAIL at the cap opens the checkpoint
// with `capped: true` so the dialog lists the open findings.
// Plan reviews never mark items or feed gates (occasion.ts countsForItems).
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CHECKPOINT_TOOL, PLAN_NAME } from "./checkpoint.ts";
import { ledgerLines } from "./ladder.ts";
import type { PanelFinding } from "./panel.ts";
import type { ReviewResult } from "./occasion.ts";
import type { Verdict } from "./rounds.ts";

/** `ceremony.planReviewRounds`: a positive integer, else 2. */
export const DEFAULT_PLAN_REVIEW_ROUNDS = 2;
export function planReviewRounds(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : DEFAULT_PLAN_REVIEW_ROUNDS;
}

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

/** The advice after the first valid write of a plan that has no review yet: a ready explorer task for the code-claims check. Advice only. */
export function claimsHintLine(planPath: string): string {
  return `pi-foreman: advice: before the first [plan-review] have an inexpensive explorer check the plan's claims about the code; a wrong claim found now saves a review round. Explorer task: "Read ${planPath}. List every claim it makes about code (file:line, symbol, caller, consumer, test named) and check each against the code with file:line. Report claims that are wrong, unverifiable or unread." Fix what it reports, then launch the review. This never blocks a review.`;
}

export interface PlanVerdict {
  hash: string;
  verdict: Verdict;
  model: string | null;
  /** The located findings of the review (findings.ts), resolved after the run-end record call. */
  findings: Promise<PanelFinding[]>;
  /** The lines of a FAIL's findings text (ledgerblock.ts failFindingsText) for the re-review task; absent for a PASS or a restore without them. Persisted with the verdict. */
  earlier?: string[];
}

const EARLIER_LINES = 40;
const EARLIER_LINE_CHARS = 400;
/** The persisted shape of a FAIL's findings text: its lines, capped (the block itself is cut again at 8 KB). */
export const earlierLinesOf = (text: string): string[] => text.split("\n").filter((l) => l.trim()).slice(0, EARLIER_LINES).map((l) => l.slice(0, EARLIER_LINE_CHARS));
/** The same from an untrusted persisted value: strings only, capped; undefined for none. */
export function earlierOfStored(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const lines = v.filter((x): x is string => typeof x === "string").slice(0, EARLIER_LINES).map((l) => l.slice(0, EARLIER_LINE_CHARS));
  return lines.length > 0 ? lines : undefined;
}

/** The primary plan-review results of a run end that carry a verdict. */
export function planReviewResults(results: readonly ReviewResult[]): (ReviewResult & { verdict: Verdict })[] {
  return results.filter((r): r is ReviewResult & { verdict: Verdict } => r.occasion === "plan-review" && r.primary && r.verdict !== null);
}

/**
 * The notice for a plan-review run that ended with no plan carrying a verdict (nothing recorded for any plan), or null when `reviewed` is not empty. Three causes: the verdict
 * was recorded but no plan file was found for it (`tried` = the paths looked at); the reviewer recorded `incomplete`; no `review_verdict` record exists (the run left none, or did not complete).
 */
export function planReviewLostNotice(results: readonly ReviewResult[], tried: readonly string[], reviewedCount: number): string | null {
  if (reviewedCount > 0) return null;
  const mine = results.filter((r) => r.occasion === "plan-review" && r.primary);
  const cause = mine.some((r) => r.verdict !== null)
    ? `a verdict was recorded, but no plan file was found for it (tried: ${tried.length > 0 ? tried.join(", ") : "no plan path in the task"})`
    : mine.some((r) => r.incomplete)
      ? `the reviewer recorded \`incomplete\`${mine.find((r) => r.incomplete)?.reason ? ` (${mine.find((r) => r.incomplete)?.reason})` : ""}`
      : "no review_verdict record was left (the reviewer made no verdict call, or the run did not complete)";
  return `pi-foreman: the plan review ended and no plan got a verdict: ${cause}. Relaunch the plan review.`;
}

/** The plan files among a plan review's files (planReviewFiles); a bare name is taken from the scratch dir. */
export function planPathsOf(files: readonly string[], scratchDir: string): string[] {
  return files.filter((f) => PLAN_NAME.test(f.split(/[\\/]/).pop() ?? "")).map((f) => (/[\\/]/.test(f) ? f : path.join(scratchDir, f)));
}

/** Plan-review verdicts per plan lineage (real plan path). */
export class PlanReviews {
  private readonly byPath = new Map<string, { latest: PlanVerdict; rounds: number; reviews: number }>();
  /** The plan path of the newest recorded or restored verdict. */
  private newestPath: string | null = null;
  /**
   * The plan text each `[plan-review]` launch's reviewer reads, per launch: keyed by the tool call id until the launch result names the run (`bindRun`), then by the run id. A verdict
   * counts for the snapshot of its own run (`keepRun`); a second launch never overwrites the first one's. In memory only.
   */
  private readonly launches = new Map<string, { batch: number | null; bound: boolean; plans: Map<string, { hash: string; text: string }> }>();
  /** The text the last verdict is for (in memory only; keyed by the real plan path). */
  private readonly reviewed = new Map<string, { hash: string; text: string }>();
  /** The key `noteLaunch` uses when no launch is named (the older per-path form). */
  private static readonly legacy = (planPath: string): string => `path:${planPath}`;

  /** A `[plan-review]` launch (`launchKey`: its tool call id): the text the reviewer will read; `batch` is the tool batch it starts in (open until `closeLaunch`/`closeRun` or the next batch). */
  noteLaunch(planPath: string, hash: string, text: string, batch?: number, launchKey: string = PlanReviews.legacy(planPath)): void {
    if (batch !== undefined) for (const [k, l] of this.launches) if (!l.bound && l.batch !== null && l.batch < batch) this.launches.delete(k); // a launch of an earlier batch that never got its result
    const l = this.launches.get(launchKey) ?? { batch: null, bound: false, plans: new Map() };
    l.plans.set(planPath, { hash, text });
    l.batch = batch ?? null;
    this.launches.delete(launchKey);
    this.launches.set(launchKey, l);
    while (this.launches.size > 64) this.launches.delete(this.launches.keys().next().value as string);
  }

  /** The launch started run `runId`: its snapshot moves to the run. */
  bindRun(launchKey: string, runId: string): void {
    const l = this.launches.get(launchKey);
    if (!l) return;
    this.launches.delete(launchKey);
    l.bound = true;
    this.launches.set(runId, l);
  }

  /** The launch was refused or failed: its snapshot goes. */
  dropLaunch(launchKey: string): void {
    this.launches.delete(launchKey);
  }

  /** The snapshot of the plan the run's reviewer read, or null (no snapshot: after a reload, or a run this adapter did not launch). */
  snapshotOf(runId: string, planPath: string): { hash: string; text: string } | null {
    return this.launches.get(runId)?.plans.get(planPath) ?? null;
  }

  /** A plan write of tool batch `batch`: every launch of that batch still open takes these bytes (the reviewer reads them). */
  refreshLaunch(planPath: string, hash: string, text: string, batch: number): boolean {
    let any = false;
    for (const l of this.launches.values()) {
      if (l.batch !== batch || !l.plans.has(planPath)) continue;
      l.plans.set(planPath, { hash, text });
      any = true;
    }
    return any;
  }

  /** The launch's run ended: a later write in the same batch is a change the reviewer did not read. */
  closeRun(runId: string): void {
    const l = this.launches.get(runId);
    if (l) l.batch = null;
  }

  /** The older per-path form of `closeRun`: every launch of the plan is closed. */
  closeLaunch(planPath: string): void {
    for (const l of this.launches.values()) if (l.plans.has(planPath)) l.batch = null;
  }

  /** The verdict of run `runId` is recorded: the text its reviewer read is the reviewed text, and its hash is the version the verdict counts for. Null without a snapshot (the reviewed text is then cleared). */
  keepRun(planPath: string, runId: string): { hash: string; text: string } | null {
    const snap = this.snapshotOf(runId, planPath);
    if (snap) this.reviewed.set(planPath, snap);
    else this.reviewed.delete(planPath);
    return snap;
  }

  /** The verdict is recorded for the plan version `hash` (a launch noted without a launch key): the text noted at launch becomes the reviewed text when its hash is the same, else the reviewed text is cleared. */
  keepReviewed(planPath: string, hash: string): void {
    const l = this.launches.get(PlanReviews.legacy(planPath))?.plans.get(planPath);
    if (l && l.hash === hash) this.reviewed.set(planPath, l);
    else this.reviewed.delete(planPath);
  }

  /** The text of the last reviewed version, or null (never reviewed, cleared, or not in memory after a reload). */
  reviewedText(planPath: string): string | null {
    return this.reviewed.get(planPath)?.text ?? null;
  }

  /** Each recorded verdict of a new plan VERSION is one round of the plan's lineage (a revision keeps the count; a repeat review of the same version does not add one). */
  record(planPath: string, v: PlanVerdict): void {
    const l = this.byPath.get(planPath);
    this.byPath.set(planPath, { latest: v, rounds: (l?.rounds ?? 0) + (l && l.latest.hash === v.hash ? 0 : 1), reviews: (l?.reviews ?? 0) + 1 });
    this.newestPath = planPath;
  }

  /** The lineage of the newest recorded or restored verdict, or null (the reload file's review flag, roundstate.ts; no checkpoint needed). */
  newest(): { latest: PlanVerdict; rounds: number; reviews: number } | null {
    return this.newestPath ? this.byPath.get(this.newestPath) ?? null : null;
  }

  /** Every lineage (the session entry, planstate.ts). */
  all(): { path: string; latest: PlanVerdict; rounds: number; reviews: number }[] {
    return [...this.byPath].map(([path, l]) => ({ path, ...l }));
  }

  /** The latest verdict and round count of a plan's lineage, or null (the reload file, roundstate.ts). */
  lineage(planPath: string): { latest: PlanVerdict; rounds: number; reviews: number } | null {
    return this.byPath.get(planPath) ?? null;
  }

  /** After a reload: put back a lineage the reload file kept. */
  restore(planPath: string, latest: PlanVerdict, rounds: number, reviews: number = rounds): void {
    this.byPath.set(planPath, { latest, rounds, reviews });
    this.newestPath = planPath;
  }

  /**
   * The verdict that lets the checkpoint open, or why it is refused. A FAIL below `cap` rounds goes back
   * for a revision; a FAIL at the cap opens it with `capped` (and the round count).
   */
  gate(planPath: string, hash: string, cap: number = DEFAULT_PLAN_REVIEW_ROUNDS): { verdict: PlanVerdict; capped?: true; rounds?: number } | { refusal: PlanReviewRefusal; stale: boolean } {
    const l = this.byPath.get(planPath);
    if (!l || l.latest.hash !== hash) return { refusal: "plan_review_required", stale: !!l };
    if (l.latest.verdict === "fail") {
      if (l.rounds < cap) return { refusal: "plan_revision_required", stale: false };
      return { verdict: l.latest, capped: true, rounds: l.rounds };
    }
    return { verdict: l.latest };
  }
}

/** The refusal text of foreman_checkpoint. */
export function planReviewRefusalText(reason: PlanReviewRefusal, rel: string, tier: string, stale: boolean): string {
  const head = `pi-foreman: ${CHECKPOINT_TOOL} refused [${reason}]:`;
  if (reason === "plan_revision_required") {
    return `${head} the plan review of ${rel} failed. Revise the plan with the review's findings. Revise the body above the appendix: an Addendum is not a revision and keeps the same plan version. Then launch the reviewer with occasion: "plan-review" (or "[plan-review]" first in its task) on the revised plan and the ledger, and repeat until it passes; ask nobody while the findings are defects or gaps. A finding that needs a decision goes to the checkpoint with a FAIL: call ${CHECKPOINT_TOOL} again after the revised plan has a verdict, and at the round cap (ceremony.planReviewRounds) it opens with the open findings.`;
  }
  const why = stale ? "the plan changed since its last review, so that verdict no longer counts" : "the plan has no review yet";
  return `${head} at tier ${tier} the checkpoint needs a reviewer verdict on the current version of the plan (ceremony.planReview), and ${why}. Launch the reviewer with occasion: "plan-review" (or "[plan-review]" first in its task), naming ${rel} and the ledger, wait for its verdict, then call ${CHECKPOINT_TOOL} again.`;
}

const one = (s: string): string => s.replace(/[\u0000-\u001f\u007f\u0080-\u009f]+/g, " ").trim().slice(0, 120);

/** The dialog section: verdict, reviewer model and the findings (file:line class note, at most PLAN_REVIEW_FINDINGS_MAX lines). */
export function planReviewSection(v: PlanVerdict, findings: readonly PanelFinding[], capped?: { rounds: number; cap: number }): string {
  const out = [capped ? `Plan review: FAIL after ${Math.min(capped.rounds, capped.cap)} of ${capped.cap} rounds; open findings:` : `Plan review: ${v.verdict.toUpperCase()} (reviewer ${v.model ?? "unknown model"})`];
  for (const f of findings.slice(0, PLAN_REVIEW_FINDINGS_MAX)) out.push(`  ${one(f.file)}${f.line === null ? "" : `:${f.line}`} ${one(f.class)} ${one(f.note)}`.trimEnd());
  if (findings.length > PLAN_REVIEW_FINDINGS_MAX) out.push(`  (+${findings.length - PLAN_REVIEW_FINDINGS_MAX} more findings)`);
  if (findings.length === 0) out.push(capped ? "  (no located findings) The review cap is reached: the owner may override this FAIL at the checkpoint (approve the plan)." : "  (no located findings)");
  return out.join("\n");
}

/** The facts line of a re-review whose launch shares its tool batch with a plan write (the bytes the reviewer reads may differ from the bytes the facts saw). */
export const PLAN_SAME_BATCH_LINE = "the plan is written in the same tool batch as this launch; no diff at launch: review the whole plan against the earlier findings";

/** At most this many diff lines go into the facts of a re-review. */
export const PLAN_DIFF_LINES = 200;

/** The unified diff of a plan against the last reviewed text for the facts of a re-review (header lines name `planPath`; at most PLAN_DIFF_LINES lines, then a count); a line saying why there is none when git gives none. */
export function planDiffLines(planPath: string, before: string, after: string): string[] {
  let dir: string | null = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-plandiff-"));
    fs.writeFileSync(path.join(dir, "reviewed"), before);
    fs.writeFileSync(path.join(dir, "current"), after);
    const r = spawnSync("git", ["diff", "--no-index", "--no-ext-diff", "--no-color", "reviewed", "current"], { cwd: dir, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
    if (r.error) return [`no diff (git did not run: ${r.error.message})`];
    if (r.status === 0) return ["no difference to the last reviewed version"];
    if (r.status !== 1) return [`no diff (git diff ended with ${r.status === null ? `signal ${r.signal}` : `status ${r.status}`})`];
    const body = r.stdout.split("\n");
    const at = body.findIndex((l) => l.startsWith("@@"));
    const lines = [`--- ${planPath} (last reviewed)`, `+++ ${planPath} (now)`, ...(at < 0 ? [] : body.slice(at))];
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.length > PLAN_DIFF_LINES ? [...lines.slice(0, PLAN_DIFF_LINES), `(+${lines.length - PLAN_DIFF_LINES} more diff lines; read the plan)`] : lines;
  } catch (e) {
    return [`no diff (${e instanceof Error ? e.message : String(e)})`];
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The facts block of a `[plan-review]` launch: the plan path and the bound ledger's open items, instead of a diff. */
export function planFactsBlock(plans: readonly string[], ledgerPath: string | null, ledger: string | null): string {
  const items = ledgerLines(ledger, "");
  return [
    "",
    "## Plan review facts (pi-foreman)",
    `Plan: ${plans.length ? plans.join(", ") : "(no plan-<topic>.html or plan-<topic>.md named in the task)"}`,
    `Ledger: ${ledgerPath ?? "(no ledger bound)"}`,
    "Open ledger items (review the plan against them: missing items, wrong order, risks):",
    ...(items.length ? items : ["(none)"]),
  ].join("\n");
}
