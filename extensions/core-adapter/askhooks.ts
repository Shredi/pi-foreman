// Harness bookkeeping for the `ask_user_question` tool, keyed on the tool name and independent of the package that
// registers it (@juicesharp/rpiv-ask-user-question, bundled). The ask.md file path (askcontract.ts) is unchanged: an
// answer to a dialog is never filed as `ruling-<n>.md`; the parent writes that file itself.
import * as fs from "node:fs";
import * as path from "node:path";
import { ASK_FILE, parseAskHeader } from "./askcontract.ts";
import { askOpen } from "./ruling.ts";

export const ASK_USER_TOOL = "ask_user_question";

/** The open ask.md of an own handoff dir: its dir and n; null when none is open. */
export function openAsk(dirs: string[]): { dir: string; n: number } | null {
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

/** Whether a result is an owner answer: not an error, not cancelled (Esc, no UI, invalid questions). */
export function askAnswered(details: unknown, isError: boolean): boolean {
  if (isError) return false;
  const d = (details ?? {}) as { cancelled?: unknown; error?: unknown };
  return d.cancelled === false && (d.error === undefined || d.error === null);
}

/** Whether a result is an owner answer with at least one answered question (an empty `answers` is not). */
export function askAnsweredSome(details: unknown, isError: boolean): boolean {
  if (!askAnswered(details, isError)) return false;
  const answers = ((details ?? {}) as { answers?: unknown }).answers;
  return Array.isArray(answers) && answers.length > 0;
}
