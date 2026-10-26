// Ledger items for builders (retro-harvest item 2): a fresh builder launch whose task cites ledger
// items ("item 3", "items 1 and 2", "#5") gets their ledger text prepended, so the brief and the
// ledger cannot drift apart. No block when the task cites none or the ledger has none of them.
// A reviewer or senior-reviewer entry gets the same prefix, or the whole ledger text when its task
// cites no item: the ledger is the scope source of a review (docs/review.md).
// The binding is the session marker, so a review launched with cwd = a worktree gets it too.
// The rung-up path already carries the same lines in its handoff (ladder.ts handoffBlock), so an
// entry that gets a handoff is skipped. Foreman side, in memory.
import { ledgerLines } from "./ladder.ts";
import { occasionOf } from "./occasion.ts";

const CITES = /\bitems?\s+(?:\d+|V)\b|#\d+\b/i;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The block for `task`, or "" when it cites no ledger item that exists. */
export function ledgerItemsBlock(ledger: string | null, task: string): string {
  if (!CITES.test(task)) return "";
  const lines = ledgerLines(ledger, task);
  if (lines.length === 0) return "";
  return ["[pi-foreman ledger items] The ledger text of the items this task cites; it is the contract.", ...lines, "[end of ledger items]", ""].join("\n");
}

const REVIEW_AGENTS = new Set(["reviewer", "senior-reviewer"]);

/** The block of a review task: the cited items, else the whole ledger (header and items); "" without a ledger. */
export function reviewLedgerBlock(ledger: string | null, task: string, ledgerPath?: string | null): string {
  const where = ledgerPath ? [`Ledger file (absolute path, readable from any directory): ${ledgerPath}`] : [];
  const cited = ledgerItemsBlock(ledger, task);
  if (cited) return where.length ? cited.replace(/\n/, `\n${where[0]}\n`) : cited;
  if (!ledger || !ledger.trim()) return "";
  return ["[pi-foreman ledger] The ledger of this round; a fact is in scope only when an item asks for it.", ...where, ledger.trim(), "[end of ledger]", ""].join("\n");
}

/** The configured `review.critic` as a string list (anything else reads as no questions). */
export const criticOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((q): q is string => typeof q === "string" && q.trim() !== "") : []);

/** The critic block of a review task (`review.critic`): the questions and the answer format; "" for an empty list. The harness does not parse the answers. */
export function criticBlock(questions: readonly string[]): string {
  if (questions.length === 0) return "";
  return ["[pi-foreman critic] Answer each question once per ledger item as a line `CRITIC: <item> Q<k>: <answer>`.", ...questions.map((q, i) => `Q${i + 1}. ${q.replace(/^\(\d+\)\s*/, "")}`), "[end of critic]", ""].join("\n");
}

const PROTECTED_PATHS = ["config/foreman.defaults.json", "config/permissions.baseline.json", "package.json"];

/**
 * The line every builder brief carries after the ledger block (R26 item 4, R46 item 6): protected (write-ask) files are staged and
 * committed by the foreman, never by the child. The protected files the task cites are named as editable.
 */
function protectedLine(task: string): string {
  const cited = PROTECTED_PATHS.filter((p) => task.includes(p));
  if (cited.length === 0) return "Protected files (package.json, config/*.json and the other write-ask paths): do not stage or commit them; the foreman stages and commits them.\n";
  return `Protected files (${cited.join(", ")}): you may edit these, the task names them; do not git add or commit them, the foreman stages and commits them. If an edit is refused, say so in your report.\n`;
}

/**
 * The re-review line (R26 item 3): a reviewer launched after an open FAIL reviews the revision diff, not the whole change. `sha` is the
 * head that FAIL reviewed; null when it is unknown.
 */
export function reReviewLine(sha: string | null): string {
  return `[pi-foreman re-review] Review the revision diff since ${sha ?? "the reviewed head"} and run only the targeted tests the task names; do not run tsc or full suites (the foreman reports them).\n`;
}

/**
 * Prepend the block to the task of every fresh builder, reviewer and senior-reviewer step of a `subagent` input (single, tasks,
 * chain, parallel); a resume and the entries in `skip` (rung-up handoff) get none. A reviewer step gets the re-review line first when
 * `reReview` is set (an open FAIL), except a `[plan-review]`, `[pre-pr]` or `[second-opinion]` task. Returns trace records.
 */
export function applyLedgerItems(input: Record<string, unknown>, ledger: string | null, skip: ReadonlySet<unknown> = new Set(), ledgerPath?: string | null, critic: readonly string[] = [], reReview: { sha: string | null } | null = null): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (typeof input.action === "string") return out;
  const visit = (e: unknown): void => {
    if (!isObj(e)) return;
    const role = typeof e.agent === "string" && (e.agent === "builder" || REVIEW_AGENTS.has(e.agent)) ? e.agent : null;
    if (role && typeof e.task === "string") {
      const block = skip.has(e) ? "" : role === "builder" ? ledgerItemsBlock(ledger, e.task) : reviewLedgerBlock(ledger, e.task, ledgerPath);
      // the critic questions go into every reviewer and senior-reviewer task (a rung-up handoff entry included), after the ledger block
      const cb = role === "builder" ? "" : criticBlock(critic);
      const re = role === "reviewer" && reReview && occasionOf(e.task) === "item" ? reReviewLine(reReview.sha) : "";
      const prot = role === "builder" && !skip.has(e) ? protectedLine(e.task) : "";
      if (block || cb || re || prot) e.task = re + block + prot + cb + e.task;
      if (block) out.push({ event: "ledger_block", role, chars: block.length });
    }
    for (const k of ["tasks", "chain", "parallel"]) if (Array.isArray(e[k])) e[k].forEach(visit);
  };
  visit(input);
  return out;
}
