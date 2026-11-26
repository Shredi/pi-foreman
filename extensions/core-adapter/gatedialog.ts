// The owner-pane dialog of the gate (r79 plan 7) and the texts of the child / headless denials. No model is involved in any of it.
//
// askOwner(): three options (allow once, deny with comment, deny and stop), the full command in the title (Pi's selector title
// is a wrapping text without scrolling, so a command above SHOW_ALL_LINES lines shows its first HEAD_LINES and last TAIL_LINES, a line over
// LINE_MAX_CHARS shows its start and end, and a trace file `<state>/gate-ask-<n>.txt` holds all of it), every dialog opened whatever the presence state with a signal of its own that follows only
// the call's abort signal and the session shutdown (a dialog closed that way is `aborted`, never an answer), a dismissed dialog denies. Nothing is
// remembered: there are no rule lists to remember into.
import * as fs from "node:fs";
import * as path from "node:path";
import type { PresenceLike, WaitTimers } from "./presencewait.ts";

export const DIALOG_OPTIONS = ["allow once", "deny with comment", "deny and stop"] as const;
export type DialogOption = (typeof DIALOG_OPTIONS)[number];
export const DEFAULT_ASK_TIMEOUT_MS = 15 * 60 * 1000;
export const SHOW_ALL_LINES = 12;
export const HEAD_LINES = 8;
export const TAIL_LINES = 3;
export const LINE_MAX_CHARS = 300;
export const LINE_HEAD_CHARS = 200;
export const LINE_TAIL_CHARS = 80;

/** Leading texts of every gate deny (floors, rules, whitelist, dialog answers, judge and protected-target refusals, self-modification, handler failure); the ledger trace reads them. */
export const GATE_DENY_PREFIXES = [
  "pi-foreman: denied",
  "pi-foreman: refused:",
  "pi-foreman: policy ",
  "pi-foreman: the permission review is unreachable",
  "pi-foreman: the permission gate failed",
  "pi-foreman: self-modification rule",
] as const;

export const userDeny = (typed: string): string => (typed.trim() ? `pi-foreman: denied by the user: ${typed.trim()}` : "pi-foreman: denied by the user.");
export const STOP_TEXT = "pi-foreman: denied by the user, who asked you to stop. Do not retry or work around this; stop and ask the owner what to do next.";

// ------------------------------------------------------------------ the owner dialog

export interface OwnerAsk {
  tool: string;
  /** The full command (heredoc bodies included) or the path / JSON payload. */
  payload: string;
  cwd: string;
  /** `danger-<name>: <reason>`, `self-modification <rule>`, `<floor rule>: <reason>`. */
  cause: string;
  /** The judge's reason when it did not clear the call. */
  classifierReason?: string;
  /** A child's ask shown in its parent's pane. */
  child?: { role: string; run: string };
}

/** The slice of Pi's `ctx.ui` the dialog uses. */
export interface OwnerUI {
  select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
  input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface OwnerDeps {
  ui: OwnerUI;
  presence?: PresenceLike;
  /** `presence.enabled`; false skips the probe and the watchdog. */
  presenceEnabled?: boolean;
  presenceTimers?: WaitTimers;
  presenceIntervalMs?: number;
  /** The call's abort signal and the session shutdown: the dialog closes without an answer (`aborted`). Presence never closes a dialog. */
  signal?: AbortSignal;
  /** `<agentDir>/pi-foreman/state`: where the full text of a long command is kept. */
  stateDir?: string;
}

export type OwnerAnswer =
  | { allow: true; how: "once"; notes: string[] }
  | { allow: false; how: "comment" | "stop" | "dismissed" | "cancelled" | "away" | "aborted"; reason: string };

/** Control characters other than newline and tab are shown as `?` (nothing a command carries may drive the terminal). */
const printable = (s: string): string => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, "?");

/** The next free `gate-ask-<n>.txt` number of the state dir. */
function nextTraceN(dir: string): number {
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = /^gate-ask-(\d+)\.txt$/.exec(f);
      if (m) n = Math.max(n, Number(m[1]));
    }
  } catch {
    // no dir yet
  }
  return n + 1;
}

/** A line over LINE_MAX_CHARS shown as its first LINE_HEAD_CHARS and last LINE_TAIL_CHARS characters around the count of what is hidden. */
function clipLine(line: string): { text: string; cut: boolean } {
  const chars = Array.from(line);
  if (chars.length <= LINE_MAX_CHARS) return { text: line, cut: false };
  const omitted = chars.length - LINE_HEAD_CHARS - LINE_TAIL_CHARS;
  return { text: `${chars.slice(0, LINE_HEAD_CHARS).join("")}… [${omitted} characters omitted] …${chars.slice(-LINE_TAIL_CHARS).join("")}`, cut: true };
}

/** The command as the title shows it: all of it up to SHOW_ALL_LINES lines, else head, an omission line and tail; a line over LINE_MAX_CHARS is clipped. When anything is cut and a stateDir is set, the full text goes to a trace file the display names; a failed write leaves the cap without the file. */
export function commandDisplay(payload: string, stateDir?: string): { text: string; file?: string } {
  const all = payload.split("\n");
  const linesCut = all.length > SHOW_ALL_LINES;
  const kept = linesCut ? [...all.slice(0, HEAD_LINES), ...all.slice(-TAIL_LINES)] : all;
  const clipped = kept.map(clipLine);
  const charsCut = clipped.some((l) => l.cut);
  if (!linesCut && !charsCut) return { text: printable(payload) };
  let file: string | undefined;
  if (stateDir) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      file = path.join(stateDir, `gate-ask-${nextTraceN(stateDir)}.txt`);
      fs.writeFileSync(file, payload, { encoding: "utf8", mode: 0o600 });
    } catch {
      file = undefined;
    }
  }
  const lines = clipped.map((l) => l.text);
  if (linesCut) {
    const omitted = all.length - HEAD_LINES - TAIL_LINES;
    lines.splice(HEAD_LINES, 0, file ? `... [${omitted} lines omitted; the full text is in ${file}]` : `... [${omitted} lines omitted]`);
  } else if (file) {
    lines.push(`... [the full text is in ${file}]`);
  }
  return { text: printable(lines.join("\n")), file };
}

export function ownerTitle(a: OwnerAsk, command: string): string {
  return [
    `pi-foreman: ${a.tool} asks`,
    ...(a.child ? [`from the ${a.child.role} (run ${a.child.run})`] : []),
    `cause: ${printable(a.cause)}`,
    ...(a.classifierReason ? [`classifier: ${printable(a.classifierReason)}`] : []),
    `cwd: ${printable(a.cwd)}`,
    "",
    command,
  ].join("\n");
}

export const DIALOG_ABORTED_TEXT = "pi-foreman: the permission dialog was closed without an answer (the call was aborted or the session ended).";

/** Ask the owner. Never throws for a dismissed dialog. The dialog opens whatever the presence state and stays open until the owner answers, the call is aborted or the session shuts down. */
export async function askOwner(a: OwnerAsk, d: OwnerDeps): Promise<OwnerAnswer> {
  const aborted: OwnerAnswer = { allow: false, how: "aborted", reason: DIALOG_ABORTED_TEXT };
  if (d.signal?.aborted) return aborted;
  const shown = commandDisplay(a.payload, d.stateDir);
  const title = ownerTitle(a, shown.text);
  const own = new AbortController();
  const follow = (): void => own.abort();
  d.signal?.addEventListener("abort", follow, { once: true });
  try {
    const value = await dialog(d, title, own.signal);
    return own.signal.aborted ? aborted : value;
  } finally {
    d.signal?.removeEventListener("abort", follow);
  }
}

async function dialog(d: OwnerDeps, title: string, signal: AbortSignal): Promise<OwnerAnswer> {
  const { ui } = d;
  const choice = await ui.select(title, [...DIALOG_OPTIONS], { signal });
  if (choice === "allow once") return { allow: true, how: "once", notes: [] };
  if (choice === "deny with comment") {
    const typed = (await ui.input("pi-foreman: reason for the deny (shown to the agent)", "", { signal })) ?? "";
    return { allow: false, how: "comment", reason: userDeny(typed) };
  }
  if (choice === "deny and stop") return { allow: false, how: "stop", reason: STOP_TEXT };
  return { allow: false, how: "dismissed", reason: userDeny("the dialog was dismissed") };
}
