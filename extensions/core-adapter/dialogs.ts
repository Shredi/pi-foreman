// `/foreman dialogs --json`: the session trace's permission-dialog records (overlay decision `ask-*`) counted per regression family.
// The family is decided at emit time from the raw command (`dialogFamily`) and kept in the existing `class` trace field; the trace
// itself keeps only the redacted, path-scrubbed `command` (trace.ts), which is what the report prints as literal lines.
import * as fs from "node:fs";

export const DIALOG_FAMILIES = ["state_usage_read", "pi_scratch_read", "toolchain_probe", "own_run_dir", "own_bg_output", "own_bash_output_log", "owned_scratch", "hub_ledger_read", "other", "auto_review_allow"] as const;
export type DialogFamily = (typeof DIALOG_FAMILIES)[number];

/** The regression family of a dialog's command (raw text, before the trace scrubs it). */
export function dialogFamily(command: string): DialogFamily {
  const c = command.replace(/\\/g, "/");
  if (/\.pi\/tasks\//.test(c)) return "own_bg_output";
  if (/\bpi-bash-[0-9a-f]+\.log\b/.test(c)) return "own_bash_output_log";
  if (/\.pi\/scratch\b/.test(c)) return "pi_scratch_read";
  if (/pi-foreman-scratch/.test(c)) return "owned_scratch";
  if (/\bLEDGER-[^\s/]*\.md\b|\.workflow\/LEDGER/.test(c)) return "hub_ledger_read";
  if (/\.pi\/[^\s/]*\/?runs?\/|\/\.pi\/runs?\b|\/pi-subagents?\/runs?\b|\basync-subagent-runs\b/.test(c)) return "own_run_dir";
  if (/(^|[\s/])(?:state|usage)[-\w.]*(?:\.jsonl?|\/)|\/(?:state|usage)\b|\busage[-_]/.test(c)) return "state_usage_read";
  if (/^\s*(?:which|command -v|type)\s+\S+|\s(?:--version|-V)\s*$|^\s*(?:node|python3?|npm|npx|tsc|git|cargo|go|java|ruby|uv)\s+(?:--version|-v|version)\b/.test(c)) return "toolchain_probe";
  return "other";
}

/** Trace fields of a dialog record: the family goes in `class`. */
export const dialogFields = (command: string): { class: DialogFamily } => ({ class: dialogFamily(command) });

export type DialogReport = Record<string, { count: number; lines: string[] }>;

/** The report of a trace file's overlay `ask-*` records, plus the asks the auto reviewer allowed without a dialog (`auto_review_allow`, R16); a missing or unreadable file reads as no records. */
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
    if (rec.event !== "overlay" || typeof rec.decision !== "string" || !rec.decision.startsWith("ask-")) continue;
    const fam = (DIALOG_FAMILIES as readonly string[]).includes(String(rec.class)) ? String(rec.class) : "other";
    out[fam].count++;
    out[fam].lines.push(typeof rec.command === "string" ? rec.command : String(rec.toolFamily ?? ""));
  }
  return out;
}

/** The `/foreman dialogs --json` text: the report, or a plain statement when the trace is off (never zero counts). */
export function dialogsJson(trace: { file: string } | null | undefined): string {
  if (!trace) return JSON.stringify({ trace: "off", message: "trace.enabled is not true: no dialogs are recorded; enable the trace to count dialogs" }, null, 2);
  return JSON.stringify(dialogReport(trace.file), null, 2);
}
