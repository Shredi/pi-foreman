// Build the Claude-hook-shaped JSON the core scripts read on stdin.
//
// What each script reads (core 0.22.0):
//   destructive_guard.py   tool_input.command, cwd, session_id
//   ledger_guard_write.py  tool_input.file_path (realpath'd against the process cwd), session_id
//   ledger_guard_spawn.py  tool_name ("Agent"), tool_input.prompt (length vs threshold),
//                          tool_input.subagent_type ("fork" exempt, never sent), session_id, cwd
//   ledger_bind.py         tool_input.file_path, session_id
//   ledger_guard_stop.py   session_id, cwd, stop_hook_active
import * as path from "node:path";
import { mapTool } from "./toolmap.ts";

export interface PayloadContext {
  sessionId: string;
  cwd: string;
  transcriptPath?: string;
  home: string;
}

type Json = Record<string, unknown>;

/** Resolve a Pi tool path the way Pi does: leading `@` stripped, `~` expanded, relative to cwd. */
export function resolveToolPath(raw: unknown, cwd: string, home: string): string | null {
  if (typeof raw !== "string" || !raw) return null;
  let p = raw.startsWith("@") ? raw.slice(1) : raw;
  if (p === "~") p = home;
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = path.join(home, p.slice(2));
  return path.resolve(cwd, p);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Every task text a `subagent` call carries (single, parallel `tasks`, `chain` steps). */
export function subagentTaskText(input: Json): string {
  const parts: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string" && v) parts.push(v);
  };
  push(input.task);
  const visit = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const step of list) {
      if (!step || typeof step !== "object") continue;
      const s = step as Json;
      push(s.task);
      visit(s.parallel);
    }
  };
  visit(input.tasks);
  visit(input.chain);
  return parts.join("\n\n");
}

/** Agent names a `subagent` call launches. */
export function subagentAgents(input: Json): string[] {
  const names: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string" && v) names.push(v);
  };
  push(input.agent);
  const visit = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const step of list) {
      if (!step || typeof step !== "object") continue;
      push((step as Json).agent);
      visit((step as Json).parallel);
    }
  };
  visit(input.tasks);
  visit(input.chain);
  return names;
}

/** Core-shaped tool_input for a Pi tool call. */
export function coreToolInput(piTool: string, input: Json, pc: PayloadContext): Json {
  switch (piTool) {
    case "bash":
    case "powershell":
      return { command: str(input.command) };
    case "write":
      return { file_path: resolveToolPath(input.path, pc.cwd, pc.home) ?? "", content: str(input.content) };
    case "edit": {
      const first = Array.isArray(input.edits) && input.edits[0] && typeof input.edits[0] === "object" ? (input.edits[0] as Json) : {};
      return {
        file_path: resolveToolPath(input.path, pc.cwd, pc.home) ?? "",
        old_string: str(first.oldText),
        new_string: str(first.newText),
      };
    }
    case "subagent":
      // No subagent_type: the core exempts "fork", and a Pi agent could be named that.
      return { prompt: subagentTaskText(input), description: subagentAgents(input).join(", ") };
    default:
      return { ...input };
  }
}

function base(pc: PayloadContext, event: string): Json {
  const out: Json = { session_id: pc.sessionId, cwd: pc.cwd, hook_event_name: event, permission_mode: "default" };
  if (pc.transcriptPath) out.transcript_path = pc.transcriptPath;
  return out;
}

export function preToolPayload(piTool: string, input: Json, pc: PayloadContext): Json {
  return { ...base(pc, "PreToolUse"), tool_name: mapTool(piTool).coreName ?? piTool, tool_input: coreToolInput(piTool, input, pc) };
}

export function postToolPayload(piTool: string, input: Json, pc: PayloadContext, isError: boolean): Json {
  return {
    ...base(pc, "PostToolUse"),
    tool_name: mapTool(piTool).coreName ?? piTool,
    tool_input: coreToolInput(piTool, input, pc),
    tool_response: { success: !isError },
  };
}

export function stopPayload(pc: PayloadContext, stopHookActive: boolean): Json {
  return { ...base(pc, "Stop"), stop_hook_active: stopHookActive };
}

/**
 * JSON with every non-ASCII character escaped. The core reads stdin with the locale
 * encoding (cp1252 on many Windows hosts); pure ASCII can never fail to decode, and a
 * decode failure would make a core script exit silently (= allow).
 */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}
