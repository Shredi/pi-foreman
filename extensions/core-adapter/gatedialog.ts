// The owner-pane dialog of the gate (r79 plan 7) and the texts of the child / headless denials. No model is involved in any of it.
//
// askOwner(): four options (allow once, allow and remember, deny with comment, deny and stop), the full command in the title (Pi's selector title
// is a wrapping text without scrolling, so a command above SHOW_ALL_LINES lines shows its first HEAD_LINES and last TAIL_LINES and names a trace
// file `<state>/gate-ask-<n>.txt` that holds all of it), every dialog opened with the presence abort signal (presencewait.ts), a dismissed
// dialog denies. "allow and remember" writes through permconfig.ts (`PermStore.writeRemember`), which refuses unless the project file's trust
// check passes; the refusal is shown to the owner and the call runs once.
import * as fs from "node:fs";
import * as path from "node:path";
import { OWNER_AWAY_TEXT, withPresence } from "./presencewait.ts";
import type { PresenceLike, WaitTimers } from "./presencewait.ts";

export const DIALOG_OPTIONS = ["allow once", "allow and remember", "deny with comment", "deny and stop"] as const;
export type DialogOption = (typeof DIALOG_OPTIONS)[number];
export const REMEMBER_OPTIONS = ["use this sentence", "edit the sentence", "cancel"] as const;
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
  /** `danger-<name>: <reason>`, `rule <text>`, `no rule matches`, `self-modification <rule>`. */
  cause: string;
  /** The classifier's reason when it escalated. */
  classifierReason?: string;
  /** A child's ask shown in its parent's pane. */
  child?: { role: string; run: string };
  /** Offered only for dangerous-class escalations and unmatched calls under mode ask: the sentence (describeCall) and the pattern rules (proposeRule), if any. */
  remember?: { sentence: string; rules: string[] | null };
}

/** The slice of Pi's `ctx.ui` the dialog uses. `editor` has no signal: the owner is at the keyboard while editing. */
export interface OwnerUI {
  select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
  input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** The slice of permconfig.ts `PermStore` the remember step uses. */
export interface RememberStore {
  projectDistrust(): string | null;
  writeRemember(input: { prose?: string; rule?: string }): { ok: true; file: string } | { ok: false; reason: string };
}

export interface OwnerDeps {
  ui: OwnerUI;
  presence?: PresenceLike;
  /** `presence.enabled`; false skips the probe and the watchdog. */
  presenceEnabled?: boolean;
  presenceTimers?: WaitTimers;
  presenceIntervalMs?: number;
  /** `<agentDir>/pi-foreman/state`: where the full text of a long command is kept. */
  stateDir?: string;
  remember?: { store: RememberStore; /** reload the permission files, clear the classifier cache */ afterWrite(): void };
}

export type OwnerAnswer =
  | { allow: true; how: "once" | "remember"; notes: string[] }
  | { allow: false; how: "comment" | "stop" | "dismissed" | "cancelled" | "away"; reason: string };

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

/** Ask the owner. Never throws for a dismissed dialog; an away owner denies without or during the dialog. */
export async function askOwner(a: OwnerAsk, d: OwnerDeps): Promise<OwnerAnswer> {
  const shown = commandDisplay(a.payload, d.stateDir);
  const title = ownerTitle(a, shown.text);
  const r = await withPresence(d.presence, (signal) => dialog(a, d, title, signal), { enabled: d.presenceEnabled, timers: d.presenceTimers, intervalMs: d.presenceIntervalMs });
  return r.away === true ? { allow: false, how: "away", reason: OWNER_AWAY_TEXT } : r.value;
}

async function dialog(a: OwnerAsk, d: OwnerDeps, title: string, signal: AbortSignal): Promise<OwnerAnswer> {
  const { ui } = d;
  const dismissed: OwnerAnswer = { allow: false, how: "dismissed", reason: userDeny("the dialog was dismissed") };
  const options = a.remember && d.remember ? [...DIALOG_OPTIONS] : DIALOG_OPTIONS.filter((o) => o !== "allow and remember");
  const choice = await ui.select(title, options, { signal });
  if (choice === "allow once") return { allow: true, how: "once", notes: [] };
  if (choice === "deny with comment") {
    const typed = (await ui.input("pi-foreman: reason for the deny (shown to the agent)", "", { signal })) ?? "";
    return { allow: false, how: "comment", reason: userDeny(typed) };
  }
  if (choice === "deny and stop") return { allow: false, how: "stop", reason: STOP_TEXT };
  if (choice !== "allow and remember" || !a.remember || !d.remember) return dismissed;

  const once = (note: string): OwnerAnswer => {
    ui.notify(note, "warning");
    return { allow: true, how: "once", notes: [note] };
  };
  const { store, afterWrite } = d.remember;
  const why = store.projectDistrust();
  if (why !== null) return once(`pi-foreman: not remembered: ${why}. The call runs once. Add \`.workflow/\` to .git/info/exclude to allow remembering.`);

  const pick = await ui.select(`Remember this as a whitelist sentence?\n\n${a.remember.sentence}`, [...REMEMBER_OPTIONS], { signal });
  if (pick === undefined) return dismissed;
  let sentence = a.remember.sentence;
  if (pick === "edit the sentence") {
    const edited = await ui.editor("Edit the whitelist sentence (it describes a type of request, up to 300 characters)", sentence);
    if (edited === undefined || !edited.trim()) return { allow: false, how: "cancelled", reason: userDeny("the remember step was cancelled") };
    sentence = edited;
  } else if (pick !== "use this sentence") return { allow: false, how: "cancelled", reason: userDeny("the remember step was cancelled") };

  let rules: string[] = [];
  if (a.remember.rules && a.remember.rules.length) {
    const yes = await ui.select(`Also add the pattern rule${a.remember.rules.length > 1 ? "s" : ""} ${a.remember.rules.join(" and ")}?`, ["yes", "no"], { signal });
    if (yes === undefined) return dismissed;
    if (yes === "yes") rules = a.remember.rules;
  }
  const notes: string[] = [];
  const w = store.writeRemember({ prose: sentence, ...(rules[0] ? { rule: rules[0] } : {}) });
  if (w.ok === false) return once(`pi-foreman: ${w.reason} The call runs once.`);
  notes.push(`remembered in ${w.file}`);
  for (const extra of rules.slice(1)) {
    const x = store.writeRemember({ rule: extra });
    if (x.ok === false) {
      ui.notify(`pi-foreman: ${x.reason}`, "warning");
      notes.push(x.reason);
    }
  }
  afterWrite();
  ui.notify(`pi-foreman: ${notes[0]}`, "info");
  return { allow: true, how: "remember", notes };
}
