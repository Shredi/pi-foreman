// The task text the judge reads as context (docs/permissions.md, "What it sees"): pure helpers. The text is copied into the judge request as quoted data; nothing here
// reads meaning from it (no match on its words), only its length and the harness-written structure around it (an entry kind, the report-back footer of a brief).
import * as fs from "node:fs";
import * as path from "node:path";
import { ledgerLines } from "./ladder.ts";

/** The custom session entry that keeps a helper agent's launch task across a reload or a resume: `{ piSessionId, task }`. Custom entries are not sent to the model. */
export const LAUNCH_TASK_ENTRY = "pi-foreman-launch-task";

/** The launch task is cut to its first `LAUNCH_HEAD` and last `LAUNCH_TAIL` characters: the harness prepends blocks, so the real task may sit late. */
export const LAUNCH_HEAD = 2500;
export const LAUNCH_TAIL = 1500;

/** `text` as the judge gets it: whole up to `LAUNCH_HEAD + LAUNCH_TAIL` characters, else its start and its end with a marker between. */
export function cutTask(text: string): string {
  if (text.length <= LAUNCH_HEAD + LAUNCH_TAIL) return text;
  return `${text.slice(0, LAUNCH_HEAD)}\n[… ${text.length - LAUNCH_HEAD - LAUNCH_TAIL} chars cut …]\n${text.slice(text.length - LAUNCH_TAIL)}`;
}

/** The bound ledger as the judge and the protected check read it: its title, then its open item lines (empty when there is none). */
export function ledgerTaskText(ledgerText: string | null): string {
  if (!ledgerText) return "";
  const title = /^#\s+(.+)$/m.exec(ledgerText)?.[1];
  return [title ?? "", ...ledgerLines(ledgerText, "")].filter(Boolean).join("\n");
}

/** The launch task a branch holds for this session: the first `pi-foreman-launch-task` entry with this session's id (an entry a fork copied in carries another id), else null. */
export function restoreLaunchTask(branch: unknown[], piSessionId: string): string | null {
  for (const raw of branch) {
    const e = raw as { type?: unknown; customType?: unknown; data?: unknown } | null;
    if (!e || e.type !== "custom" || e.customType !== LAUNCH_TASK_ENTRY) continue;
    const d = e.data as { piSessionId?: unknown; task?: unknown } | null | undefined;
    if (d && typeof d === "object" && d.piSessionId === piSessionId && typeof d.task === "string" && d.task !== "") return d.task;
  }
  return null;
}

/** The report-back footer `foreman_session.py` appends to an opened brief, local and remote form: the fixed rule and heading line. */
const FOOTER = /\n---\n\n## Report back \(pi-foreman (?:remote )?session `[^`\n]*`\)/g;

/** `brief.md` text without the harness-written footer (the last footer heading on, so the brief's own text stays). */
export function stripBriefFooter(text: string): string {
  let at = -1;
  for (const m of text.matchAll(FOOTER)) at = m.index;
  return (at >= 0 ? text.slice(0, at) : text).trim();
}

/** The opening brief of a child session: `brief.md` in its handoff dir (local or remote handoff dir), footer dropped; null when unreadable or empty. Later `brief-<n>.md` are not read. */
export function readBrief(handoffDir: string | undefined): string | null {
  const dir = handoffDir?.trim();
  if (!dir || !path.isAbsolute(dir)) return null;
  try {
    const t = stripBriefFooter(fs.readFileSync(path.join(dir, "brief.md"), "utf8"));
    return t || null;
  } catch {
    return null;
  }
}
