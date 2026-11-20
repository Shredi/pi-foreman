// The owner-pane dialog of the gate (r79 plan 7) and the texts of the child / headless denials. No model is involved in any of it.
//
// askOwner(): three options (allow once, deny with comment, deny and stop), the full command in the title (Pi's selector title
// is a wrapping text without scrolling, so a command above SHOW_ALL_LINES lines shows its first HEAD_LINES and last TAIL_LINES and names a trace
// file `<state>/gate-ask-<n>.txt` that holds all of it), every dialog opened whatever the presence state with a signal of its own that follows only
// the call's abort signal and the session shutdown (a dialog closed that way is `aborted`, never an answer), a dismissed dialog denies. Nothing is
// remembered: there are no rule lists to remember into.
import * as fs from "node:fs";
import * as path from "node:path";
import type { PresenceLike, WaitTimers } from "./presencewait.ts";

export const DIALOG_OPTIONS = ["allow once", "deny with comment", "deny and stop"] as const;
export type DialogOption = (typeof DIALOG_OPTIONS)[number];
export const DEFAULT_ASK_TIMEOUT_MS = 15 * 60 * 1000;
export const SHOW_ALL_LINES = 60;
export const HEAD_LINES = 40;
export const TAIL_LINES = 20;

/** Leading texts of every gate deny (floors, rules, whitelist, dialog answers, self-modification, handler failure); the ledger trace reads them. */
export const GATE_DENY_PREFIXES = [
  "pi-foreman: denied",
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

/** The command as the title shows it: all of it up to SHOW_ALL_LINES lines, else head, an omission line naming the trace file, and tail. */
export function commandDisplay(payload: string, stateDir?: string): { text: string; file?: string } {
  const lines = payload.split("\n");
  if (lines.length <= SHOW_ALL_LINES) return { text: printable(payload) };
  if (!stateDir) return { text: printable(payload) };
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const file = path.join(stateDir, `gate-ask-${nextTraceN(stateDir)}.txt`);
    fs.writeFileSync(file, payload, { encoding: "utf8", mode: 0o600 });
    const omitted = lines.length - HEAD_LINES - TAIL_LINES;
    return { text: printable([...lines.slice(0, HEAD_LINES), `... [${omitted} lines omitted; the full text is in ${file}]`, ...lines.slice(-TAIL_LINES)].join("\n")), file };
  } catch {
    return { text: printable(payload) };
  }
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
