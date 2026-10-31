// ask_user_question (R16 item 5): a structured in-pane question for a human at the pane (foreman only). When a handoff dir where this
// session is the child holds an open ask.md, the answer is also written to `ruling-<n>.md`. No UI (print/rpc/json mode, unattended) or a
// dismissed question (r79 item 5): the result says the owner is absent.
import * as fs from "node:fs";
import * as path from "node:path";
import { ASK_FILE, parseAskHeader } from "./askcontract.ts";
import { askOpen } from "./ruling.ts";

export const ASK_USER_TOOL = "ask_user_question";
export const OTHER_OPTION = "Other (type an answer)";
export const OWNER_ABSENT_TEXT = "no human at this pane; the owner is absent. Decide with the information you have or report what needs an answer.";

export interface AskQuestion {
  question: string;
  options: string[];
  allowFreeText: boolean;
}

export interface AskUserDeps {
  hasUI: boolean;
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
  };
  /** The handoff dirs where this session is the child (owned.ts childHandoffDirs), never those it opened as parent. */
  ownDirs: () => string[];
}

export interface AskUserResult {
  text: string;
  decision: "answered" | "no_ui" | "dismissed" | "refused";
  ruling?: string;
}

export function parseQuestions(params: unknown): { questions: AskQuestion[] } | { error: string } {
  const raw = (params as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) return { error: `${ASK_USER_TOOL}: questions must hold 1 to 4 entries.` };
  const questions: AskQuestion[] = [];
  for (const q of raw as Array<Record<string, unknown>>) {
    const opts = q?.options;
    if (typeof q?.question !== "string" || !q.question.trim()) return { error: `${ASK_USER_TOOL}: every question needs a non-empty question text.` };
    if (!Array.isArray(opts) || opts.length < 2 || opts.length > 4 || opts.some((o) => typeof o !== "string" || !o.trim())) return { error: `${ASK_USER_TOOL}: every question needs 2 to 4 non-empty options.` };
    questions.push({ question: q.question.trim(), options: opts as string[], allowFreeText: q.allowFreeText !== false });
  }
  return { questions };
}

/** The open ask.md of an own handoff dir: its dir and n; null when none is open. */
function openAsk(dirs: string[]): { dir: string; n: number } | null {
  for (const dir of dirs) {
    try {
      if (!askOpen(dir)) continue;
      const head = parseAskHeader(fs.readFileSync(path.join(dir, ASK_FILE), "utf8"));
      if (head) return { dir, n: head.n };
    } catch {
      // unreadable dir: not an open ask
    }
  }
  return null;
}

export async function askUserQuestion(params: unknown, d: AskUserDeps): Promise<AskUserResult> {
  const parsed = parseQuestions(params);
  if ("error" in parsed) return { text: parsed.error, decision: "refused" };
  if (!d.hasUI) return { text: OWNER_ABSENT_TEXT, decision: "no_ui" };
  const lines: string[] = [];
  for (const [i, q] of parsed.questions.entries()) {
    const title = parsed.questions.length > 1 ? `(${i + 1}/${parsed.questions.length}) ${q.question}` : q.question;
    let answer = await d.ui.select(title, q.allowFreeText ? [...q.options, OTHER_OPTION] : q.options);
    if (answer === OTHER_OPTION) answer = await d.ui.input(q.question, "your answer");
    if (answer === undefined || !answer.trim()) return { text: OWNER_ABSENT_TEXT, decision: "dismissed" };
    lines.push(`${i + 1}. ${q.question}\n   Answer: ${answer.trim()}`);
  }
  const body = lines.join("\n");
  const open = openAsk(d.ownDirs());
  let ruling: string | undefined;
  if (open) {
    const file = path.join(open.dir, `ruling-${open.n}.md`);
    try {
      fs.writeFileSync(file, `${body}\n`, { encoding: "utf8", flag: "wx" });
      ruling = file;
    } catch {
      // a ruling already exists (or the dir is unwritable): the answer still returns to the agent
    }
  }
  return { text: `${body}${ruling ? `\nAlso written to ${ruling}.` : ""}`, decision: "answered", ...(ruling ? { ruling } : {}) };
}
