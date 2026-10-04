// Pi tool name -> core tool name and the core scripts that fire for it (design §7).

export type GuardName =
  | "destructive_guard"
  | "ledger_guard_write"
  | "ledger_guard_spawn"
  | "ledger_bind"
  | "ledger_guard_stop"
  | "git_guard";

export interface ToolMapping {
  /** Tool name the core scripts expect, or null when the core has no equivalent. */
  coreName: string | null;
  /** Scripts run at `tool_call`, in order. */
  pre: GuardName[];
  /** Scripts run at `tool_result` (side effect only). */
  post: GuardName[];
}

const NONE: ToolMapping = Object.freeze({ coreName: null, pre: [], post: [] }) as ToolMapping;

// `edit` deliberately skips the write gate: ledger_guard_write.py does not look at
// tool_name, so it would deny the Edit that the core documents as THE way to bind an
// existing ledger (core hooks.json runs it for `^Write$` only).
const TABLE: Record<string, ToolMapping> = {
  bash: { coreName: "Bash", pre: ["destructive_guard", "git_guard"], post: [] },
  powershell: { coreName: "Bash", pre: ["destructive_guard", "git_guard"], post: [] },
  write: { coreName: "Write", pre: ["ledger_guard_write"], post: ["ledger_bind"] },
  edit: { coreName: "Edit", pre: [], post: ["ledger_bind"] },
  subagent: { coreName: "Agent", pre: ["ledger_guard_spawn"], post: [] },
  read: { coreName: "Read", pre: [], post: [] },
  grep: { coreName: "Grep", pre: [], post: [] },
  find: { coreName: "Glob", pre: [], post: [] },
  ls: { coreName: "Glob", pre: [], post: [] },
};

/** Mapping for a Pi tool. Unknown tools (codemode, MCP, extension tools) map to none. */
export function mapTool(piTool: string): ToolMapping {
  return Object.prototype.hasOwnProperty.call(TABLE, piTool) ? TABLE[piTool] : NONE;
}

export function isShellTool(piTool: string): boolean {
  return piTool === "bash" || piTool === "powershell";
}
