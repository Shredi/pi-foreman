// The owner dialog a session has open, kept in the session's own state (`<agent dir>/pi-foreman/state/open-dialog/<session id>.json`) so that a
// restart (a crash, an update, a closed window) can ask the owner again. The file lists each open owner dialog: its kind word, when it opened,
// the tool, and what the dialog showed (the questions of `ask_user_question`, the plan path of a checkpoint, the call summary of a guard
// dialog). It is removed when an answer or a dismissal is stored. At session start a file that is still there means a restart ended the dialog:
// the adapter appends ONE message (never system text, the cache prefix stays) that says so and asks the child to ask the owner again. An old
// answer is never replayed: the message carries the question, not the answer.
import fs from "node:fs";
import path from "node:path";
import { cleanLabel } from "./herdr.ts";
import type { BlockKind } from "./herdr.ts";

export const OPEN_DIALOG_MESSAGE_TYPE = "pi-foreman-open-dialog";
const MAX_DIALOGS = 8;
const MAX_DETAIL = 4000;
const KINDS = new Set(["approval", "question", "checkpoint", "script", "confirm", "dialog", "hold", "parent-ask"]);

export interface OpenDialog {
  kind: BlockKind;
  /** The dialog's own title, cleaned (cleanLabel). */
  label: string;
  /** ISO time the dialog opened. */
  since: string;
  /** The tool whose call opened it (`ask_user_question`, `foreman_checkpoint`, a guarded tool), when known. */
  tool?: string;
  /** `ask_user_question`: the questions as the call gave them; the text is capped. */
  questions?: unknown;
  /** `foreman_checkpoint`: the plan path of the call. */
  path?: string;
  /** A guard dialog: the call summary the dialog showed. */
  summary?: string;
}

export const openDialogFile = (agentDir: string, sessionId: string): string => path.join(agentDir, "pi-foreman", "state", "open-dialog", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "") || "session"}.json`);

const text = (v: unknown, n = 300): string | undefined => (typeof v === "string" && v.trim() ? cleanLabel(v).slice(0, n) : undefined);

/** The detail of an owner dialog as `withBlockedOn` passes it (`{tool, questions?, path?, summary?}`), reduced to the fields the file keeps. */
export function dialogOf(kind: BlockKind, label: string, detail: Record<string, unknown> | undefined, now: Date): OpenDialog {
  const d = detail ?? {};
  const tool = text(d.tool, 60);
  const p = text(d.path, 500);
  const summary = text(d.summary, 200);
  let questions: unknown;
  if (d.questions !== undefined) {
    try {
      const j = JSON.stringify(d.questions);
      if (j !== undefined && j.length <= MAX_DETAIL) questions = JSON.parse(j);
    } catch {
      // not serialisable: the dialog is kept without its questions
    }
  }
  return { kind, label: cleanLabel(label), since: now.toISOString(), ...(tool ? { tool } : {}), ...(questions !== undefined ? { questions } : {}), ...(p ? { path: p } : {}), ...(summary ? { summary } : {}) };
}

/** The dialogs a session has open now, mirrored to the file; the file is removed when the last one is closed. */
export class OpenDialogs {
  private readonly file: string;
  private readonly open = new Map<number, OpenDialog>();
  private seq = 0;

  constructor(agentDir: string, sessionId: string) {
    this.file = openDialogFile(agentDir, sessionId);
  }

  /** A dialog opened; returns its token for `close`. */
  add(d: OpenDialog): number {
    const token = ++this.seq;
    this.open.set(token, d);
    this.sync();
    return token;
  }

  /** The dialog returned an answer or a dismissal (`keep` false), or its session is going away and a restart must ask again (`keep` true: the file stays). */
  close(token: number, keep = false): void {
    if (!this.open.delete(token) || keep) return;
    this.sync();
  }

  private sync(): void {
    try {
      if (this.open.size === 0) {
        fs.rmSync(this.file, { force: true });
        return;
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, dialogs: [...this.open.values()].slice(0, MAX_DIALOGS) })}\n`, "utf8");
      fs.renameSync(tmp, this.file);
    } catch {
      // best effort: no file means no re-ask
    }
  }
}

/** The dialogs a restart ended (the file at session start), validated field by field; empty when there is none. */
export function readOpenDialogs(agentDir: string, sessionId: string): OpenDialog[] {
  let j: { v?: unknown; dialogs?: unknown };
  try {
    j = JSON.parse(fs.readFileSync(openDialogFile(agentDir, sessionId), "utf8"));
  } catch {
    return [];
  }
  if (!j || j.v !== 1 || !Array.isArray(j.dialogs)) return [];
  const out: OpenDialog[] = [];
  for (const raw of j.dialogs.slice(0, MAX_DIALOGS)) {
    const d = raw as Record<string, unknown> | null;
    if (!d || typeof d.kind !== "string" || !KINDS.has(d.kind) || typeof d.since !== "string") continue;
    const tool = text(d.tool, 60);
    const p = text(d.path, 500);
    const summary = text(d.summary, 200);
    out.push({ kind: d.kind as BlockKind, label: text(d.label, 80) ?? "dialog", since: d.since.slice(0, 40), ...(tool ? { tool } : {}), ...(d.questions !== undefined ? { questions: d.questions } : {}), ...(p ? { path: p } : {}), ...(summary ? { summary } : {}) });
  }
  return out;
}

export function removeOpenDialogs(agentDir: string, sessionId: string): void {
  try {
    fs.rmSync(openDialogFile(agentDir, sessionId), { force: true });
  } catch {
    // nothing to remove
  }
}

/** One dialog as one line of the re-ask message: what it was and what to do again. */
function lineOf(d: OpenDialog): string {
  if (d.kind === "checkpoint") return `- plan checkpoint${d.path ? ` of ${d.path}` : ""}: call foreman_checkpoint again with that path.`;
  if (d.kind === "question" || d.tool === "ask_user_question") return `- question to the owner: call ask_user_question again with the same questions${d.questions !== undefined ? `: ${JSON.stringify(d.questions)}` : ""}.`;
  if (d.kind === "approval") return `- approval for a child run's call to ${d.tool ?? "a tool"}${d.summary ? ` (${d.summary})` : ""}: the restart ended it, and that call was the child's, not yours. Wait for the child to ask again, or relaunch the run if you still need it; the owner is asked then.`;
  if (d.kind === "script") return `- owner script approval: propose the script again with foreman_script if you still need it.`;
  return `- ${d.kind} dialog${d.label ? ` "${d.label}"` : ""}${d.tool ? ` of ${d.tool}` : ""}: repeat the step that opened it if you still need it.`;
}

/** The message appended once at session start for the dialogs a restart ended; fixed words plus the listed fields. No answer is carried. */
export function reAskText(dialogs: OpenDialog[]): string {
  return [
    `pi-foreman notice: this session was restarted while ${dialogs.length === 1 ? "a dialog" : "dialogs"} for the owner ${dialogs.length === 1 ? "was" : "were"} open. The restart ended ${dialogs.length === 1 ? "it" : "them"}; the owner gave no answer and nothing earlier is replayed. Ask the owner again now, then go on with the work:`,
    ...dialogs.map(lineOf),
  ].join("\n");
}
