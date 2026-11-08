// Owner-readable text (docs/ceremony.md "Owner summary"): the `## For the owner` section every plan opens with, the
// deterministic jargon rule shared by the plan-review facts, the question hint and the foreman_show hint, the
// context prefix of ask_user_question questions, and the foreman_show opening check. Advice only: nothing here refuses.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { clean, planBody } from "./checkpoint.ts";
import { workspaceOf } from "./python.ts";

/** The owner section is at most this many lines (wrapped at OWNER_COLS) and OWNER_CHARS characters. */
export const OWNER_LINES = 10;
export const OWNER_COLS = 100;
export const OWNER_CHARS = 1000;

const OWNER_HEADING = /^##[ \t]+for the owner[ \t]*$/i;
const LEVEL2 = /^##[ \t]+\S/;
const LEVEL12 = /^#{1,2}[ \t]+\S/;
const FENCE = /^[ \t]*(```|~~~)/;

export interface OwnerSection {
  /** The body lines, without leading and trailing blank lines. */
  lines: string[];
  /** Whether it is the first `##` section of the plan body. */
  first: boolean;
}

/** The first `## For the owner` section of the plan body above any appendix (planBody), or null. */
export function ownerSection(text: string): OwnerSection | null {
  const all = planBody(Buffer.from(text, "utf8")).toString("utf8").split(/\r?\n/);
  let fenced = false;
  let at = -1;
  let firstLevel2 = -1;
  for (let i = 0; i < all.length; i++) {
    if (FENCE.test(all[i])) fenced = !fenced;
    if (fenced) continue;
    if (firstLevel2 < 0 && LEVEL2.test(all[i])) firstLevel2 = i;
    if (OWNER_HEADING.test(all[i])) {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  const lines: string[] = [];
  fenced = false;
  for (const l of all.slice(at + 1)) {
    if (FENCE.test(l)) fenced = !fenced;
    if (!fenced && LEVEL12.test(l)) break;
    lines.push(l);
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
  return /^[\w@-]+(?:\.[\w@-]+)*$/.test(t) && EXT.test(t) && /[A-Za-z]/.test(t.split(".")[0]);
};

/** Deterministic jargon hits (at most `max`, distinct): code spans, paths, identifiers, ledger and issue ids, commit hashes. */
export function jargonHits(text: string, max = 3): string[] {
  const hits: string[] = [];
  const add = (s: string): void => {
    if (!hits.includes(s) && hits.length < max) hits.push(s);
  };
  const prose = text.split(/\r?\n/).filter((l) => !FENCE.test(l));
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const m of line.matchAll(/`[^`\n]+`/g)) add(m[0]);
    for (const tok of line.split(/\s+/)) if (tok && pathLike(tok)) add(tok.replace(/^[("'<\[]+|[)"'>\],.;:!?]+$/g, ""));
    for (const m of line.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) add(m[0]);
    for (const m of line.matchAll(/\b[a-z]{2,}(?:[A-Z][a-z0-9]+)+\b/g)) add(m[0]);
    for (const m of line.matchAll(/(?<![\w&])#\d+\b/g)) add(m[0]);
    for (const m of line.matchAll(/\b[rR]\d{2,3}\b/g)) add(m[0]);
    for (const m of line.matchAll(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g)) add(m[0]);
  }
  void prose;
  return hits;
}

/** The rule violations of a plan's owner section; empty when it is fine. */
export function ownerSectionIssues(text: string): string[] {
  const sec = ownerSection(text);
  if (!sec) return ["missing"];
  const issues: string[] = [];
  if (!sec.first) issues.push("not the first ## section");
  const wrapped = sec.lines.filter((l) => l.trim()).reduce((n, l) => n + Math.max(1, Math.ceil(l.length / OWNER_COLS)), 0);
  const chars = sec.lines.join("\n").length;
  if (wrapped > OWNER_LINES || chars > OWNER_CHARS) issues.push(`too long (${wrapped} lines wrapped at ${OWNER_COLS} columns, ${chars} characters; at most ${OWNER_LINES} lines and ${OWNER_CHARS} characters)`);
  if (!sec.lines.some((l) => l.trim())) issues.push("empty");
  const jargon = jargonHits(sec.lines.join("\n"));
  if (jargon.length) issues.push(`jargon: ${jargon.join(" ")}`);
  return issues;
}

/** Facts lines of a `[plan-review]` launch, one per plan file (relative paths resolve against `cwd`). */
export function ownerFactsLines(planPaths: readonly string[], cwd: string): string[] {
  return planPaths.map((p) => {
    let text: string;
    try {
      text = fs.readFileSync(path.resolve(cwd, p), "utf8");
    } catch {
      return `Owner section (${p}): plan not readable`;
    }
    const sec = ownerSection(text);
    const issues = ownerSectionIssues(text);
    return `Owner section (${p}): ${!sec ? "missing" : issues.length ? `issues: ${issues.join("; ")}` : `present (${sec.lines.filter((l) => l.trim()).length} lines)`}`;
  });
}

/** The owner section for the checkpoint dialog (control characters stripped, 200 characters a line), or the warning line. */
export function ownerSummary(text: string): string {
  const sec = ownerSection(text);
  if (!sec || !sec.lines.some((l) => l.trim())) return '⚠ No "For the owner" summary in this plan.';
  const lines = sec.lines.filter((l) => l.trim());
  return ["For the owner", ...lines.slice(0, OWNER_LINES).map((l) => `  ${clean(l)}`), ...(lines.length > OWNER_LINES ? ["  …"] : [])].join("\n");
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
  return hits.length ? `pi-foreman: the question text reads like jargon (${hits.join(" ")}). The owner reads it cold: say in plain words what is decided and why, no paths, identifiers or ids, recommended option first with a one-line consequence.` : null;
}

/** The hint for a foreman_show reply when the note does not open with a short plain paragraph, else null. */
export function showHint(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (!lines[i].trim() || /^#{1,6}[ \t]/.test(lines[i]))) i++;
  const para: string[] = [];
  for (; i < lines.length && lines[i].trim(); i++) para.push(lines[i]);
  const text = para.join(" ").trim();
  const plain = text !== "" && !FENCE.test(para[0] ?? "") && !/^[|>#]/.test(text) && !/^(?:[-*+]|\d+[.)])[ \t]/.test(text);
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim()).length;
  if (plain && sentences <= 3) return null;
  return "pi-foreman hint: open the note with a plain 2-3 sentence summary (what it is about and the answer), before tables, code or diagrams; the owner may open it cold.";
}
