// Core script result -> Pi `tool_call` / settle result (design §7).
import { NO_PYTHON_FIX } from "./python.ts";
import type { GuardRun } from "./runguard.ts";
import type { GuardName } from "./toolmap.ts";

export interface HookDecision {
  decision: "allow" | "deny" | "ask" | "none";
  reason?: string;
  updatedInput?: Record<string, unknown>;
}

export type GuardOutcome = { kind: "decision"; d: HookDecision } | { kind: "failure"; message: string };

/**
 * What happens when a script cannot give an answer (no Python, timeout, crash, garbage):
 *   destructive_guard   closed: the shell call is blocked (stricter than the core's own fail-open)
 *   ledger_guard_spawn  closed: the gate IS the ledger rule's enforcement; a silent pass drops it
 *   ledger_guard_write  closed only when the target is a live ledger under .workflow/ (the only
 *                       files the gate protects); every other write passes so a missing Python
 *                       does not freeze all editing
 *   ledger_bind         open: side effect only; the user is notified
 *   ledger_guard_stop   open: a broken gate must not trap the session in a continue loop
 *   git_guard           closed: commit/push lint (main) and the child git block list
 */
export type FailPolicy = "closed" | "open" | "closed-if-ledger-target";
export const FAIL_POLICY: Record<GuardName, FailPolicy> = {
  destructive_guard: "closed",
  ledger_guard_spawn: "closed",
  ledger_guard_write: "closed-if-ledger-target",
  ledger_bind: "open",
  ledger_guard_stop: "open",
  git_guard: "closed",
};

const LABEL: Record<GuardName, string> = {
  destructive_guard: "destructive guard",
  ledger_guard_spawn: "spawn gate",
  ledger_guard_write: "ledger write gate",
  ledger_bind: "ledger binding",
  ledger_guard_stop: "stop gate",
  git_guard: "git guard",
};

function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    if (last === undefined) return undefined;
    try {
      return JSON.parse(last);
    } catch {
      return undefined;
    }
  }
}

/** Parse a core script's stdout. Empty stdout = no decision. Non-JSON = not ok. */
export function parseHookStdout(stdout: string): { ok: true; d: HookDecision } | { ok: false } {
  const text = stdout.trim();
  if (!text) return { ok: true, d: { decision: "none" } };
  const data = parseJsonLoose(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false };
  const obj = data as Record<string, unknown>;
  const hso = obj.hookSpecificOutput;
  if (hso && typeof hso === "object") {
    const h = hso as Record<string, unknown>;
    const pd = h.permissionDecision;
    const decision = pd === "deny" || pd === "ask" || pd === "allow" ? pd : "none";
    const d: HookDecision = { decision };
    if (typeof h.permissionDecisionReason === "string") d.reason = h.permissionDecisionReason;
    if (h.updatedInput && typeof h.updatedInput === "object") d.updatedInput = h.updatedInput as Record<string, unknown>;
    return { ok: true, d };
  }
  if (obj.decision === "block") return { ok: true, d: { decision: "deny", reason: typeof obj.reason === "string" ? obj.reason : "" } };
  return { ok: true, d: { decision: "none" } };
}

export function failureMessage(guard: GuardName, run: GuardRun, python: string | null): string {
  const what = `pi-foreman: ${LABEL[guard]} could not run`;
  if (run.status === "failed") {
    if (run.failure === "no-python") return `${what} (no Python ≥ 3.9 found). ${NO_PYTHON_FIX}`;
    if (run.failure === "timeout") return `${what} (${run.detail}). Check that ${python ?? "Python"} starts quickly (antivirus scans, slow disk) and run /foreman doctor.`;
    return `${what} (could not start ${python ?? "Python"}: ${run.detail}). Set python.path or PI_FOREMAN_PYTHON to a working interpreter; run /foreman doctor.`;
  }
  const err = run.stderr.trim().split(/\r?\n/).slice(-1)[0] ?? "";
  if (run.code !== 0) return `${what} (exit ${run.code} without a decision${err ? `: ${err.slice(0, 200)}` : ""}). Check that core/scripts is complete (reinstall pi-foreman) and run /foreman doctor.`;
  return `${what} (unreadable output). Check that core/scripts is the vendored core and run /foreman doctor.`;
}

export function evaluateRun(guard: GuardName, run: GuardRun, python: string | null): GuardOutcome {
  if (run.status === "failed") return { kind: "failure", message: failureMessage(guard, run, python) };
  const parsed = parseHookStdout(run.stdout);
  if (!parsed.ok) return { kind: "failure", message: failureMessage(guard, run, python) };
  if (parsed.d.decision === "none" && run.code !== 0) return { kind: "failure", message: failureMessage(guard, run, python) };
  return { kind: "decision", d: parsed.d };
}

export interface AskEnv {
  /** True inside a pi-subagents child (PI_SUBAGENT_CHILD=1). */
  isChild: boolean;
  mode: string;
  hasUI: boolean;
  confirm?: (title: string, message: string) => Promise<boolean>;
}

export interface ToolCallTranslation {
  result?: { block: true; reason: string };
  /** Set when a fail-open guard could not run; the caller notifies. */
  openFailure?: string;
}

export interface TranslateInput {
  guard: GuardName;
  outcome: GuardOutcome;
  piTool: string;
  /** The live `event.input`; mutated in place for updatedInput. */
  input: Record<string, unknown>;
  ask: AskEnv;
  /** For the write gate: the target is a live ledger under .workflow/. */
  ledgerTarget?: boolean;
}

function block(reason: string): ToolCallTranslation {
  return { result: { block: true, reason } };
}

export async function translateToolCall(t: TranslateInput): Promise<ToolCallTranslation> {
  if (t.outcome.kind === "failure") {
    const policy = FAIL_POLICY[t.guard];
    if (policy === "closed" || (policy === "closed-if-ledger-target" && t.ledgerTarget)) return block(t.outcome.message);
    return { openFailure: t.outcome.message };
  }
  const d = t.outcome.d;
  const reason = d.reason || `pi-foreman: blocked by the ${LABEL[t.guard]}`;
  if (d.decision === "deny") return block(reason);
  if (d.decision === "ask") {
    if (t.ask.isChild) return block(`${reason} — this needs approval: ask the foreman (core-guard asks are not forwarded from children).`);
    if ((t.ask.mode === "tui" || t.ask.mode === "rpc") && t.ask.hasUI && t.ask.confirm) {
      let ok = false;
      try {
        ok = await t.ask.confirm("pi-foreman: approval needed", reason);
      } catch {
        ok = false;
      }
      if (!ok) return block(`Denied by the user. ${reason}`);
    } else {
      return block(`${reason} — needs approval, no UI (mode: ${t.ask.mode}).`);
    }
  }
  applyUpdatedInput(t.piTool, t.input, d.updatedInput);
  return {};
}

/**
 * Apply a core `updatedInput` to the Pi input in place. Only `bash` takes it: the
 * destructive guard's rewrite is a POSIX `export PATH=...;` prefix that would break a
 * PowerShell command.
 */
export function applyUpdatedInput(piTool: string, input: Record<string, unknown>, updated?: Record<string, unknown>): void {
  if (!updated) return;
  if (piTool === "bash" && typeof updated.command === "string") input.command = updated.command;
}

/** Stop gate: hold the settle (continue + reason) or let it settle. */
export function translateStop(outcome: GuardOutcome): { hold: boolean; reason?: string; openFailure?: string } {
  if (outcome.kind === "failure") return { hold: false, openFailure: outcome.message };
  if (outcome.d.decision === "deny") return { hold: true, reason: outcome.d.reason || "pi-foreman: the ledger still has open items." };
  return { hold: false };
}
