// Questions and answers between sessions travel as intercom messages (docs/sessions.md, "Message contract"). Two small in-memory pieces:
//  - the child side: a successful `send` to the parent lets the turn end without the finish checks (`waitingForParent`);
//  - the parent side: one record per open child session whose message starts with `Question` (label and time, never the text),
//    kept until the parent answers it, so the one-minute pass of childblocked.ts can remind the parent once.
// Nothing here is displayed, written to a file or part of the live file.
import * as fs from "node:fs";
import * as path from "node:path";
import { INTERCOM_TOOL } from "./intercomguard.ts";

/** What a tool result must carry to count as a delivered intercom `send`: its target, or undefined (not a send, an error, not delivered). */
export function deliveredSendTo(ev: { toolName: string; input: unknown; isError?: boolean; details?: unknown; content?: unknown }): string | undefined {
  if (ev.toolName !== INTERCOM_TOOL || ev.isError) return undefined;
  const i = ev.input && typeof ev.input === "object" ? (ev.input as Record<string, unknown>) : {};
  if (i.action !== "send" || typeof i.to !== "string" || !i.to.trim()) return undefined;
  const d = ev.details && typeof ev.details === "object" ? (ev.details as Record<string, unknown>) : {};
  if (d.error) return undefined;
  // `delivered` is true for a send held in the broker mailbox as well; the text covers a result without details
  const text = Array.isArray(ev.content) ? ev.content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("\n") : "";
  const ok = d.delivered === true || (d.delivered === undefined && /^Message sent to |waiting in the broker mailbox/.test(text));
  return ok ? i.to.trim() : undefined;
}

/** `to` (an id, an id prefix of at least 4 characters, or a name) addresses the session `id`, which is known by `names`. */
export function addresses(to: string, id: string, names: Iterable<string> = []): boolean {
  if (!to || !id) return false;
  if (to === id) return true;
  const lower = to.toLowerCase();
  for (const n of names) if (n.toLowerCase() === lower) return true;
  return to.length >= 4 && id.startsWith(to);
}

/** The ids in the `parent` files of the handoff dirs where this session is the child (read at every call: the parent can change). */
export function parentIdsOf(childDirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of childDirs) {
    try {
      const id = fs.readFileSync(path.join(dir, "parent"), "utf8").split(/\r?\n/)[0].trim();
      if (id) out.push(id);
    } catch {
      // no parent file
    }
  }
  return out;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Sender id and name of an inbound intercom message (its details), or null. */
export function senderOf(details: unknown): { id: string; name: string } | null {
  const from = obj(obj(details).from);
  return typeof from.id === "string" && from.id ? { id: from.id, name: typeof from.name === "string" ? from.name : "" } : null;
}

/** First line of an inbound intercom message body, read from its details (the message content starts with `**From …**`). */
export function firstLineOf(details: unknown): string {
  const d = obj(details);
  const text = typeof d.bodyText === "string" ? d.bodyText : typeof obj(obj(d.message).content).text === "string" ? (obj(obj(d.message).content).text as string) : "";
  return text.split(/\r?\n/, 1)[0].trim();
}

/** A question: the first line starts with the word `Question`. A `Plan from` line is not one. */
export const isQuestion = (details: unknown): boolean => /^Question\b/.test(firstLineOf(details));

export interface QuestionRecord {
  child: string;
  label: string;
  /** The time of the question (ms). */
  at: number;
  /** The reminder went out. */
  reminded: boolean;
}

const MAX_NAMES = 64;

export class IntercomCarry {
  /** Names senders used, by intercom id: a send by name is matched against them. */
  private names = new Map<string, Set<string>>();
  readonly records = new Map<string, QuestionRecord>();

  /** An inbound intercom message: remember the sender's name. */
  seen(details: unknown): void {
    const s = senderOf(details);
    if (!s?.name) return;
    const set = this.names.get(s.id);
    if (set) set.add(s.name);
    else if (this.names.size < MAX_NAMES) this.names.set(s.id, new Set([s.name]));
  }

  namesOf(id: string): string[] {
    return [...(this.names.get(id) ?? [])];
  }

  /** A question of an open child: one record per child; a question that comes while one is open keeps the older time. */
  note(child: string, label: string, now: number): void {
    if (!this.records.has(child)) this.records.set(child, { child, label, at: now, reminded: false });
  }

  /** The parent sent `to` a message: drop the record of the child it addresses. */
  answered(to: string): void {
    for (const r of [...this.records.values()]) if (addresses(to, r.child, [r.label, ...this.namesOf(r.child)])) this.records.delete(r.child);
  }
}
