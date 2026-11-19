// Owner-readable text (docs/ceremony.md "Owner summary"): the `## Summary` section every plan opens with (the older `## For the owner` is still accepted), the
// deterministic jargon rule shared by the plan-review facts and the question hint, and the context prefix of
// ask_user_question questions. Jargon is advice only; the plan form (planFormIssues: presence, position) is what a
// `[plan-review]` launch is refused for (index.ts).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { clean, planBody, readPlan } from "./checkpoint.ts";
import type { PlanOpts } from "./checkpoint.ts";
import { alertOf, quoteBlockAt, scanFence } from "./pages.ts";
import { fencedMask, flat, goalParagraph, ownerSectionOf, topHeading } from "./plansection.ts";
import type { OwnerSection } from "./plansection.ts";
import { workspaceOf } from "./python.ts";

export type { OwnerSection } from "./plansection.ts";

/** The first `## Summary` or `## For the owner` section of the plan body above any appendix (planBody), or null; a later heading of either name is an ordinary section. */
export function ownerSection(text: string): OwnerSection | null {
  return ownerSectionOf(planBody(Buffer.from(text, "utf8")).toString("utf8").split(/\r?\n/));
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

/**
 * The form hints of a plan's owner section (advice only, never a refusal; not part of ownerSectionIssues): no `**Goal:**` paragraph first, no numbered steps,
 * a box (alert quote) followed by other content. Empty for a missing section or a complete one.
 */
export function ownerFormHints(text: string): string[] {
  const sec = ownerSection(text);
  if (!sec) return [];
  const hints: string[] = [];
  const fenced = fencedMask(sec.lines);
  if (!goalParagraph(sec.lines)) hints.push("no **Goal:** paragraph");
  if (!sec.lines.some((l, i) => !fenced[i] && /^ {0,3}\d{1,9}[.)][ \t]/.test(l))) hints.push("no numbered steps");
  let boxSeen = false;
  let late = false;
  for (let i = 0; i < sec.lines.length; i++) {
    if (fenced[i] || !sec.lines[i].trim()) {
      if (fenced[i] && boxSeen) late = true;
      continue;
    }
    const q = quoteBlockAt(sec.lines, i);
    if (q && alertOf(q.body)) {
      boxSeen = true;
      i = q.next - 1;
    } else if (boxSeen) late = true;
  }
  if (late) hints.push("a box is not at the end");
  return hints;
}

/** The form faults a `[plan-review]` launch is refused for: the owner section's presence and position (not jargon), and each missing `opts.requiredHeadings` heading. */
export function planFormIssues(text: string, opts: { requiredHeadings?: readonly string[] }): string[] {
  const issues = ownerSectionIssues(text).filter((i) => !i.startsWith("jargon:"));
  const lines = planBody(Buffer.from(text, "utf8")).toString("utf8").split(/\r?\n/);
  const fenced = fencedMask(lines);
  const headings = new Set(lines.flatMap((l, i) => { const h = fenced[i] ? null : topHeading(l); return h?.level === 2 && h.text ? [h.text.toLowerCase()] : []; }));
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
    const abs = path.resolve(cwd, p);
    const r = opts ? readPlan(abs, opts) : null;
    // a markdown file readPlan refuses (outside the scratch dir) and with no page beside it: the direct read, as without opts
    const lone = abs.endsWith(".md") && !fs.existsSync(abs.replace(/\.md$/, ".html"));
    if (r && "error" in r && !lone) return `Summary section (${p}): plan not readable`;
    text = r && "plan" in r ? r.plan.markdown : fs.readFileSync(path.resolve(cwd, p), "utf8");
  } catch {
    return `Summary section (${p}): plan not readable`;
  }
  const sec = ownerSection(text);
  const issues = ownerSectionIssues(text);
  const hints = ownerFormHints(text);
  return `Summary section (${p}): ${!sec ? "missing" : issues.length ? `issues: ${issues.join("; ")}` : "present (checked by the harness)"}${hints.length ? `; form hints: ${hints.join("; ")}` : ""}`;
}

/** A quote block as the page renders it: an alert's marker line is dropped and its body shown with the prefix stripped, recursively (depth 8 as the page); a plain quote keeps its lines. */
function quoteLines(lines: readonly string[], at: number, q: { body: string[]; next: number }, depth: number): string[] {
  if (depth >= 8 || !alertOf(q.body)) return lines.slice(at, q.next);
  const body = q.body.slice(1);
  const fenced = fencedMask(body);
  const out: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const inner = fenced[i] ? null : quoteBlockAt(body, i);
    if (inner) {
      out.push(...quoteLines(body, i, inner, depth + 1));
      i = inner.next - 1;
    } else out.push(body[i]);
  }
  return out;
}

/** The whole Summary section for the checkpoint dialog (control characters stripped, 200 characters a line, a diagram as a pointer), or the warning line. */
export function ownerSummary(text: string): string {
  const sec = ownerSection(text);
  if (!sec || !sec.lines.some((l) => l.trim())) return '⚠ No "Summary" section in this plan.';
  const spans = diagramSpans(sec.lines);
  const fenced = fencedMask(sec.lines);
  const shown: string[] = [];
  for (let i = 0; i < sec.lines.length; i++) {
    const span = spans.find(([a, b]) => i >= a && i <= b);
    if (span) {
      if (i === span[0]) shown.push("(diagram: see the plan page)");
      continue;
    }
    if (fenced[i]) {
      shown.push(sec.lines[i]);
      continue;
    }
    const q = quoteBlockAt(sec.lines, i);
    if (q) {
      shown.push(...quoteLines(sec.lines, i, q, 0));
      i = q.next - 1;
      continue;
    }
    shown.push(sec.lines[i]);
  }
  const lines = shown.filter((l) => l.trim());
  return ["Summary", ...lines.map((l) => `  ${clean(l)}`)].join("\n");
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
