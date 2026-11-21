// The `## Reviews` block of a pull request body (docs/tools.md, pr_create): one harness-owned line between two markers that names the newest reviewer PASS on the
// PR's head. `pr_create` builds it from the session's review records and merges it into the body it was given; the PR watch of a PR the session opened refreshes
// it through the host op `pr_body` when a new PASS lands on a new head. Lines outside the markers are never touched. scripts/pr_ops.py merge_reviews_block does the same merge on the host's body.
import type { ReviewRecord } from "./reviews.ts";

export const REVIEWS_OPEN = "<!-- pi-foreman:reviews -->";
export const REVIEWS_CLOSE = "<!-- /pi-foreman:reviews -->";
/** The body cap of `pr_create` (scripts/pr_ops.py). */
export const BODY_MAX_BYTES = 65536;

/** The facts of the newest PASS on a head. */
export interface ReviewPass {
  head: string;
  occasion?: "item" | "pre-pr";
  run?: string;
  suites?: { command: string; result: string }[];
}

/** The pair a body line is keyed on: a same-tree alias keeps the run id but has a new head, so neither alone is the key. */
export const markOf = (f: Pick<ReviewPass, "head" | "run">): { head: string; run: string } => ({ head: f.head, run: f.run ?? "" });
export const sameMark = (a: { head: string; run: string } | undefined, b: { head: string; run: string }): boolean => !!a && a.head === b.head && a.run === b.run;

/** The newest code review of `head` when it is a PASS (the PR gate's rule, reviews.ts passHeads: the last verdict per head), else null. A plan review is never one. */
export function reviewFactsFor(records: readonly ReviewRecord[], head: string): ReviewPass | null {
  const last = records.findLast((r) => r.head === head && r.kind !== "plan");
  if (!last || last.verdict !== "pass") return null;
  return { head, ...(last.occasion ? { occasion: last.occasion } : {}), ...(last.run ? { run: last.run } : {}), ...(last.suites ? { suites: last.suites } : {}) };
}

const safeRun = (run: string): string => (/^[A-Za-z0-9._-]{1,100}$/.test(run) ? run : "");

/** A suite command as one inline code span (backticks and line breaks taken out), so an @mention in it pings no one. */
const codeSpan = (command: string): string => `\`${command.replace(/`/g, "").replace(/\s+/g, " ").trim() || "unnamed"}\``;

/** `Pre-pr review: PASS on <short sha> (run <run id>; suites: a (pass), b (fail))`; `Review: PASS (<occasion>) on …` when the PASS is not a `[pre-pr]` one. Absent parts are left out. */
export function reviewsLine(f: ReviewPass): string {
  const prePr = f.occasion === "pre-pr";
  const parts: string[] = [];
  const run = f.run ? safeRun(f.run) : "";
  if (run) parts.push(`run ${run}`);
  if (f.suites && f.suites.length > 0) parts.push(`suites: ${f.suites.map((s) => `${codeSpan(s.command)} (${s.result})`).join(", ")}`);
  else if (prePr) parts.push("suites: none named");
  const lead = prePr ? "Pre-pr review: PASS" : `Review: PASS${f.occasion ? ` (${f.occasion})` : ""}`;
  return `${lead} on ${f.head.slice(0, 7)}${parts.length > 0 ? ` (${parts.join("; ")})` : ""}`;
}

/** The marker-wrapped block of a PASS. */
export const reviewsBlock = (f: ReviewPass): string => `${REVIEWS_OPEN}\n${reviewsLine(f)}\n${REVIEWS_CLOSE}`;

/**
 * `body` with `block` in place: the lines from the last opening marker line before the first closing marker line that follows an opening one are replaced.
 * A marker counts only as a whole line, so prose that names the marker strings is never rewritten; a stray closing marker line is skipped, so a second update
 * finds the block the first one appended. Without a block the `## Reviews` section is appended.
 */
export function mergeReviewsBlock(body: string, block: string): string {
  const lines = body.split("\n");
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l === REVIEWS_OPEN + REVIEWS_CLOSE) return [...lines.slice(0, i), block, ...lines.slice(i + 1)].join("\n"); // an empty block on one line
    if (l === REVIEWS_OPEN) open = i;
    else if (l === REVIEWS_CLOSE && open >= 0) return [...lines.slice(0, open), block, ...lines.slice(i + 1)].join("\n");
  }
  const lead = body === "" ? "" : `${body.endsWith("\n") ? "" : "\n"}\n`;
  return `${body}${lead}## Reviews\n\n${block}\n`;
}

/**
 * The body `pr_create` sends: `body` with the block of the PASS on `head` merged in. No PASS (the PR gate off) or a merge past the cap: `body` as given (`capped` says the second).
 */
export function bodyWithReviews(body: string, facts: ReviewPass | null): { body: string; written: boolean; capped: boolean } {
  if (!facts) return { body, written: false, capped: false };
  const merged = mergeReviewsBlock(body, reviewsBlock(facts));
  if (Buffer.byteLength(merged, "utf8") > BODY_MAX_BYTES) return { body, written: false, capped: true };
  return { body: merged, written: true, capped: false };
}
