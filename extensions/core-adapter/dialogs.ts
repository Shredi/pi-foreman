// `/foreman dialogs --json`: the session trace's blocking dialogs counted per family: overlay asks (decision `ask-*`, regression family by
// command), permission-system prompts, forwarded child prompts, checkpoint dialogs, ask_user_question, guard asks and drift asks (R18: `dialog`
// records with a `surface`, and the guard's `ask` record), plus a `total` of the blocking families (dialogsJson).
// The overlay family is decided at emit time from the raw command (`dialogFamily`) and kept in the existing `class` trace field; the trace
// itself keeps only the redacted, path-scrubbed `command` (trace.ts), which is what the report prints as literal lines.
import * as fs from "node:fs";

export const DIALOG_FAMILIES = ["state_usage_read", "trace_read", "self_ruling_refusal", "pi_scratch_read", "toolchain_probe", "own_run_dir", "own_bg_output", "own_bash_output_log", "owned_scratch", "hub_ledger_read", "other", "auto_review_allow", "permission_prompt", "child_dialogs", "checkpoint", "ask_user_question", "guard_ask", "drift_ask"] as const;
/** The families that are no blocking dialog: an ask the auto reviewer allowed without one, and a refusal. Everything else counts in `total`. */
const NOT_BLOCKING = new Set<string>(["auto_review_allow", "self_ruling_refusal"]);
/** `dialog` record `surface` -> family. */
const SURFACE_FAMILY: Record<string, DialogFamily> = { permission: "permission_prompt", child: "child_dialogs", checkpoint: "checkpoint", ask_user: "ask_user_question", drift: "drift_ask" };
export type DialogFamily = (typeof DIALOG_FAMILIES)[number];

/** The regression family of a dialog's command (raw text, before the trace scrubs it). */
export function dialogFamily(command: string): DialogFamily {
  const c = command.replace(/\\/g, "/");
  if (/a session (?:cannot write|never writes) its own parent's ruling/.test(c)) return "self_ruling_refusal";
  if (/\.pi\/tasks\//.test(c)) return "own_bg_output";
  if (/\bpi-bash-[0-9a-f]+\.log\b/.test(c)) return "own_bash_output_log";
  if (/\.pi\/scratch\b/.test(c)) return "pi_scratch_read";
  if (/pi-foreman-scratch/.test(c)) return "owned_scratch";
  if (/\bLEDGER-[^\s/]*\.md\b|\.workflow\/LEDGER/.test(c)) return "hub_ledger_read";
  if (/\.pi\/[^\s/]*\/?runs?\/|\/\.pi\/runs?\b|\/pi-subagents?\/runs?\b|\basync-subagent-(?:runs|results)\b/.test(c)) return "own_run_dir";
  if (/(^|[\s/])trace-[\w.-]*\.jsonl?\b/.test(c)) return "trace_read";
  if (/(^|[\s/])(?:state|usage)[-\w.]*(?:\.jsonl?|\/)|\/(?:state|usage)\b|\busage[-_]/.test(c)) return "state_usage_read";
  if (/^\s*(?:which|command -v|type)\s+\S+|\s(?:--version|-V)\s*$|^\s*(?:node|python3?|npm|npx|tsc|git|cargo|go|java|ruby|uv)\s+(?:--version|-v|version)\b/.test(c)) return "toolchain_probe";
  return "other";
}

/** Trace fields of a dialog record: the family goes in `class`. */
export const dialogFields = (command: string): { class: DialogFamily } => ({ class: dialogFamily(command) });

export type DialogReport = Record<string, { count: number; lines: string[] }>;

/** The report of a trace file: overlay `ask-*` records, `dialog` records (one family per `surface`), guard asks that were answered (`ask` approved|denied), the self-ruling refusals (guard `self_ruling`) and the asks the auto reviewer allowed without a dialog (`auto_review_allow`, R16); a missing or unreadable file reads as no records. */
export function dialogReport(traceFile: string): DialogReport {
  const out: DialogReport = {};
  for (const f of DIALOG_FAMILIES) out[f] = { count: 0, lines: [] };
  let text = "";
  try {
    text = fs.readFileSync(traceFile, "utf8");
  } catch {
    return out;
  }
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec.event === "auto_review_allow") {
      out.auto_review_allow.count++;
      out.auto_review_allow.lines.push(typeof rec.command === "string" ? rec.command : String(rec.toolFamily ?? ""));
      continue;
    }
    // the self-ruling refusal (index.ts guard record) is a block, not an overlay ask, and counts in its own family
    if (rec.event === "guard" && rec.guard === "self_ruling" && rec.decision === "blocked") {
      out.self_ruling_refusal.count++;
      out.self_ruling_refusal.lines.push(typeof rec.command === "string" ? rec.command : String(rec.toolFamily ?? ""));
      continue;
    }
    // R41 gate dialog (index.ts gateAsk): one record per owner dialog or round ruling wait, counted in the family of its command
    if (rec.event === "dialog" && rec.guard === "gate") {
      const fam = (DIALOG_FAMILIES as readonly string[]).includes(String(rec.class)) ? String(rec.class) : "other";
      out[fam].count++;
      out[fam].lines.push(typeof rec.command === "string" ? rec.command : String(rec.toolFamily ?? ""));
      continue;
    }
    if (rec.event === "dialog") {
      const f = SURFACE_FAMILY[String(rec.surface)];
      if (!f) continue;
      out[f].count++;
      // R41 item 15: the full command (redacted at the writer, never cut) when the record carries one
      const who = typeof rec.agent === "string" ? rec.agent : String(rec.surface);
      out[f].lines.push(typeof rec.command === "string" && rec.command ? (typeof rec.agent === "string" ? `${who}: ${rec.command}` : rec.command) : who);
      continue;
    }
    // a guard's ask dialog that a human answered (no-ui and child outcomes opened none here)
    if (rec.event === "ask" && (rec.decision === "approved" || rec.decision === "denied")) {
      out.guard_ask.count++;
      out.guard_ask.lines.push(`${String(rec.guard ?? "")}:${String(rec.toolFamily ?? "")}`);
      continue;
    }
    if (rec.event !== "overlay" || typeof rec.decision !== "string" || !rec.decision.startsWith("ask-")) continue;
    const fam = (DIALOG_FAMILIES as readonly string[]).includes(String(rec.class)) ? String(rec.class) : "other";
    out[fam].count++;
    out[fam].lines.push(typeof rec.command === "string" ? rec.command : String(rec.toolFamily ?? ""));
  }
  return out;
}

/** Sum of the blocking families of a report (not `auto_review_allow`, not `self_ruling_refusal`). */
const dialogTotal = (r: DialogReport): number => Object.entries(r).reduce((n, [f, v]) => (NOT_BLOCKING.has(f) ? n : n + v.count), 0);

/** The `/foreman dialogs --json` text: the report and its `total`, or a plain statement when the trace is off (never zero counts). */
export function dialogsJson(trace: { file: string } | null | undefined): string {
  if (!trace) return JSON.stringify({ trace: "off", message: "trace.enabled is not true: no dialogs are recorded; enable the trace to count dialogs" }, null, 2);
  const report = dialogReport(trace.file);
  return JSON.stringify({ ...report, total: dialogTotal(report) }, null, 2);
}
