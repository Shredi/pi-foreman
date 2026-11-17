// Owner-readable text (docs/ceremony.md "Owner summary"): the `## For the owner` section every plan opens with, the
// deterministic jargon rule shared by the plan-review facts and the question hint, and the context prefix of
// ask_user_question questions. Jargon is advice only; the plan form (planFormIssues: presence, position) is what a
// `[plan-review]` launch is refused for (index.ts).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { clean, planBody, readPlan } from "./checkpoint.ts";
import type { PlanOpts } from "./checkpoint.ts";
import { scanFence } from "./pages.ts";
import { workspaceOf } from "./python.ts";

const OWNER_HEADING = /^##[ \t]+for the owner[ \t]*$/i;
const LEVEL2 = /^##[ \t]+\S/;
const LEVEL12 = /^#{1,2}[ \t]+\S/;

/** The lines without their indent, so a fence nested in a list item (4+ spaces or a tab, which `blocks` in pages.ts renders) is found by the same scanner. */
const flat = (lines: readonly string[]): string[] => lines.map((l) => l.trimStart());

/** Per line: whether it belongs to a fenced block, nested ones included (its opening and closing lines included). */
function fencedMask(lines: readonly string[]): boolean[] {
  const mask: boolean[] = new Array(lines.length).fill(false);
  const flatLines = flat(lines);
  for (let i = 0; i < lines.length; i++) {
    const f = scanFence(flatLines, i);
    if (!f) continue;
    mask.fill(true, i, f.next);
    i = f.next - 1;
  }
  return mask;
}

export interface OwnerSection {
  /** The body lines, without leading and trailing blank lines. */
  lines: string[];
  /** Whether it is the first `##` section of the plan body. */
  first: boolean;
}

/** The first `## For the owner` section of the plan body above any appendix (planBody), or null. */
export function ownerSection(text: string): OwnerSection | null {
  const all = planBody(Buffer.from(text, "utf8")).toString("utf8").split(/\r?\n/);
  const fenced = fencedMask(all);
  let at = -1;
  let firstLevel2 = -1;
  for (let i = 0; i < all.length; i++) {
    if (fenced[i]) continue;
    if (firstLevel2 < 0 && LEVEL2.test(all[i])) firstLevel2 = i;
    if (OWNER_HEADING.test(all[i])) {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  const lines: string[] = [];
  for (let i = at + 1; i < all.length; i++) {
    if (!fenced[i] && LEVEL12.test(all[i])) break;
    lines.push(all[i]);
  }
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return { lines, first: at === firstLevel2 };
}

const EXT = /\.(?:ts|tsx|js|mjs|cjs|py|md|json|ya?ml|toml|sh|css|html|lock|txt)$/i;
const pathLike = (raw: string): boolean => {
  const t = raw.replace(/^[("'<\[]+|[)"'>\],.;:!?]+$/g, "");
  if (!/[A-Za-z0-9]/.test(t)) return false;
  if (t.includes("/")) return /^(?:\/|\.{1,2}\/|~\/)/.test(t) || t.split("/").length > 2 || EXT.test(t);
  if (/^[A-Z][A-Za-z0-9]*\.js$/.test(t)) return false; // product names such as Node.js, Next.js
  return /^[\w@-]+(?:\.[\w@-]+)*$/.test(t) && EXT.test(t) && /[A-Za-z]/.test(t.split(".")[0]);
};

/** Deterministic jargon hits (at most `max`, distinct): code spans, paths, identifiers, ledger and issue ids, commit hashes. */
export function jargonHits(text: string, max = 3): string[] {
  const hits: string[] = [];
  const add = (s: string): void => {
    if (!hits.includes(s) && hits.length < max) hits.push(s);
  };
  const all = text.split(/\r?\n/);
  const fenced = fencedMask(all);
  for (const [n, line] of all.entries()) {
    if (fenced[n]) continue;
    for (const m of line.matchAll(/`[^`\n]+`/g)) add(m[0]);
    for (const tok of line.split(/\s+/)) if (tok && pathLike(tok)) add(tok.replace(/^[("'<\[]+|[)"'>\],.;:!?]+$/g, ""));
    for (const m of line.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) add(m[0]);
    for (const m of line.matchAll(/\b[a-z]{2,}(?:[A-Z][a-z0-9]+)+\b/g)) add(m[0]);
    for (const m of line.matchAll(/(?<![\w&])#\d+\b/g)) add(m[0]);
    for (const m of line.matchAll(/\b[rR]\d{2,3}\b/g)) add(m[0]);
    for (const m of line.matchAll(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g)) add(m[0]);
  }
  return hits;
}

/** The first and last line index of each mermaid fence in a section (an unclosed one runs to the end). */
function diagramSpans(lines: string[]): [number, number][] {
  const spans: [number, number][] = [];
  const flatLines = flat(lines);
  for (let i = 0; i < lines.length; i++) {
    const f = scanFence(flatLines, i);
    if (!f) continue;
    if (f.info.trim().split(/\s+/)[0] === "mermaid") spans.push([i, f.next - 1]);
    i = f.next - 1;
  }
  return spans;
}

/** The rule violations of a plan's owner section; empty when it is fine. */
export function ownerSectionIssues(text: string): string[] {
  const sec = ownerSection(text);
  if (!sec) return ["missing"];
  const issues: string[] = [];
  if (!sec.first) issues.push("not the first ## section");
  if (!sec.lines.some((l) => l.trim())) issues.push("empty");
  const jargon = jargonHits(sec.lines.join("\n"));
  if (jargon.length) issues.push(`jargon: ${jargon.join(" ")}`);
  return issues;
}

/** The form faults a `[plan-review]` launch is refused for: the owner section's presence and position (not jargon), and each missing `opts.requiredHeadings` heading. */
export function planFormIssues(text: string, opts: { requiredHeadings?: readonly string[] }): string[] {
  const issues = ownerSectionIssues(text).filter((i) => !i.startsWith("jargon:"));
  const lines = planBody(Buffer.from(text, "utf8")).toString("utf8").split(/\r?\n/);
  const fenced = fencedMask(lines);
  const headings = new Set(lines.flatMap((l, i) => (fenced[i] ? [] : ((/^##[ \t]+(\S.*?)[ \t]*$/.exec(l) ?? [])[1]?.toLowerCase() ?? []))));
  for (const h of opts.requiredHeadings ?? []) if (!headings.has(h.toLowerCase())) issues.push(`missing heading: ${h}`);
  return issues;
}

/** The plain-language rule for owner text, in one place: instructions, hints and the plan-review facts point at it. */
export const OWNER_TEXT_POINTS = "short sentences, one instruction or fact each; active voice; one word for one thing; common words, a needed term explained once; steps as a list";

/** Facts lines of a `[plan-review]` launch, one per plan file (relative paths resolve against `cwd`). With `opts` the plan is read through readPlan: an HTML plan is checked on its markdown copy. */
export function ownerFactsLines(planPaths: readonly string[], cwd: string, opts?: PlanOpts): string[] {
  return planPaths.map((p) => `${ownerFactLine(p, cwd, opts)}; judge it as owner text: ${OWNER_TEXT_POINTS}`);
}

function ownerFactLine(p: string, cwd: string, opts?: PlanOpts): string {
  let text: string;
  try {
    const r = opts ? readPlan(path.resolve(cwd, p), opts) : null;
    if (r && "error" in r) return `Owner section (${p}): plan not readable`;
    text = r && "plan" in r ? r.plan.markdown : fs.readFileSync(path.resolve(cwd, p), "utf8");
  } catch {
    return `Owner section (${p}): plan not readable`;
  }
  const sec = ownerSection(text);
  const issues = ownerSectionIssues(text);
  return `Owner section (${p}): ${!sec ? "missing" : issues.length ? `issues: ${issues.join("; ")}` : "present (checked by the harness)"}`;
}

/** The whole owner section for the checkpoint dialog (control characters stripped, 200 characters a line, a diagram as a pointer), or the warning line. */
export function ownerSummary(text: string): string {
  const sec = ownerSection(text);
  if (!sec || !sec.lines.some((l) => l.trim())) return '⚠ No "For the owner" summary in this plan.';
  const spans = diagramSpans(sec.lines);
  const shown = sec.lines.flatMap((l, i) => {
    const span = spans.find(([a, b]) => i >= a && i <= b);
    return span ? (i === span[0] ? ["(diagram: see the plan page)"] : []) : [l];
  });
  const lines = shown.filter((l) => l.trim());
  return ["For the owner", ...lines.map((l) => `  ${clean(l)}`)].join("\n");
}

/** The project name for question prefixes: the folder above the git common dir (so a worktree shows the repository), else the workspace folder. */
const projectNames = new Map<string, string>();
export function projectNameOf(cwd: string): string {
  const known = projectNames.get(cwd);
  if (known) return known;
  let name = "";
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (common) {
      const abs = path.resolve(cwd, common);
      name = path.basename(abs) === ".git" ? path.basename(path.dirname(abs)) : path.basename(abs).replace(/\.git$/, "");
    }
  } catch {
    // not a git checkout: fall back below
  }
  name ||= path.basename(workspaceOf(cwd).root) || path.basename(path.resolve(cwd));
  projectNames.set(cwd, name);
  return name;
}

/** `[<project> · <session label>] ` (the label only for an opened session). */
export const questionPrefix = (project: string, label: string | null): string => `[${label ? `${project} · ${label}` : project}] `;

interface AskInput {
  questions?: { question?: unknown; options?: { description?: unknown }[] }[];
}

/** Prefixes every question text in place (idempotent); returns how many were changed. */
export function prefixQuestions(input: unknown, prefix: string): number {
  let n = 0;
  for (const q of (input as AskInput | null)?.questions ?? []) {
    if (q && typeof q.question === "string" && !q.question.startsWith(prefix)) {
      q.question = prefix + q.question;
      n++;
    }
  }
  return n;
}

/** The hint for the agent when question texts or option descriptions read like jargon (never blocks), else null. */
export function questionHint(input: unknown, prefix: string): string | null {
  const texts: string[] = [];
  for (const q of (input as AskInput | null)?.questions ?? []) {
    if (typeof q?.question === "string") texts.push(q.question.startsWith(prefix) ? q.question.slice(prefix.length) : q.question);
    for (const o of q?.options ?? []) if (typeof o?.description === "string") texts.push(o.description);
  }
  const hits = jargonHits(texts.join("\n"), 4);
  return hits.length ? `pi-foreman: the question text reads like jargon (${hits.join(" ")}). The owner reads it cold: write it as owner text (plain, no jargon): say what is decided and why, no paths, identifiers or ids, recommended option first with a one-line consequence.` : null;
}
