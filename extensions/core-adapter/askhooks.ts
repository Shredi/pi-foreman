// Harness bookkeeping for the `ask_user_question` tool, keyed on the tool name and independent of the package that
// registers it (@juicesharp/rpiv-ask-user-question, bundled). The ask.md file path (askcontract.ts) is unchanged: when
// a handoff dir where this session is the child holds an open ask.md, an answer is also written to `ruling-<n>.md`.
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

/** The text of a tool result's content blocks. */
export function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((c) => (c && typeof c === "object" && (c as { type?: unknown }).type === "text" ? String((c as { text?: unknown }).text ?? "") : "")).filter(Boolean).join("\n");
}

/** Writes `ruling-<n>.md` for an open ask.md from the answer text (notes included); returns its path, or undefined when nothing was written. */
export function writeAskRuling(ownDirs: string[], content: unknown, details: unknown, isError: boolean): string | undefined {
  if (!askAnswered(details, isError)) return undefined;
  const text = resultText(content).trim();
  if (!text) return undefined;
  const open = openAsk(ownDirs);
  if (!open) return undefined;
  const file = path.join(open.dir, `ruling-${open.n}.md`);
  try {
    fs.writeFileSync(file, `${text}\n`, { encoding: "utf8", flag: "wx" });
    return file;
  } catch {
    // a ruling already exists (or the dir is unwritable): the answer still reaches the agent
    return undefined;
  }
}
