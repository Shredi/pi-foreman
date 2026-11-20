// The start note (docs/retro.md#start-note): a main session without a parent gets one message at its first prompt that lists the open report entries
// seen by two or more sessions. A message, never system text, so the cached prefix only grows; sent once, recorded in a session entry.
import { DATA_LINE, entryLine, foldRows, readRows, storeFor } from "./reports.ts";

export const START_NOTE_ENTRY = "pi-foreman-start-note";
export const START_NOTE_TYPE = "pi-foreman-start-note";
/** Entry lines in the note. */
export const START_NOTE_LINES = 5;
export const START_NOTE_MIN_COUNT = 2;

/** The note for the store of `cwd`: the data line, up to five open entries with count >= 2 (most sessions first), the hint. Null when no entry qualifies or the store is unreadable. */
export function startNoteText(cwd: string): string | null {
  let entries;
  try {
    entries = foldRows(readRows(storeFor(cwd).file));
  } catch {
    return null;
  }
  const hits = entries.filter((e) => e.state === "open" && e.count >= START_NOTE_MIN_COUNT).sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1));
  if (!hits.length) return null;
  const more = hits.length - START_NOTE_LINES;
  return [DATA_LINE, ...hits.slice(0, START_NOTE_LINES).map((e) => entryLine(e)), `${more > 0 ? `${more} more. ` : ""}Use foreman_reports (list, group, set) to look at the reports.`].join("\n");
}

/** True when `branch` (the session entries) holds the start-note entry: a reload or resume of the session does not send it again. */
export function startNoteRecorded(branch: readonly unknown[]): boolean {
  return branch.some((e) => !!e && typeof e === "object" && (e as { type?: unknown }).type === "custom" && (e as { customType?: unknown }).customType === START_NOTE_ENTRY);
}
