// The R41 gate: the single tool_call decision point. Slice 1 is the skeleton: parse -> floors -> continue.
// TODO(slice 2..4): defaults and path rules, review, dialog, log. Until then a call that passes the floors continues
// into the handlers that exist today, so nothing is loosened. A handler failure denies (fail-safe).
import * as os from "node:os";
import { lineFloors, pathFloors, type FloorEnv, type FloorHit } from "./floors.ts";
import { parseShell } from "./shellast.ts";

export interface GateDeps {
  /** The floor environment for the call's cwd (roots, protected branches, git lookups). */
  env: (cwd: string) => FloorEnv;
}

export type GateResult = { block: true; reason: string; rule: string } | undefined;

const SHELL_TOOLS = new Set(["bash", "foreman_bg", "bg_run"]);
const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls", "foreman_move", "foreman_copy"]);

const blocked = (h: FloorHit): GateResult => ({ block: true, reason: h.reason, rule: h.rule });

/** The command text of a shell-like tool call, or null. */
function commandOf(toolName: string, input: Record<string, unknown>): string | null {
  if (!SHELL_TOOLS.has(toolName)) return null;
  const c = input.command ?? input.cmd;
  return typeof c === "string" ? c : null;
}

export function gateDecide(toolName: string, input: unknown, cwd: string, deps: GateDeps): GateResult {
  try {
    const inp = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const env = deps.env(cwd);
    const cmd = commandOf(toolName, inp);
    if (cmd !== null) {
      const segs = parseShell(cmd, { cwd, platform: env.platform });
      const h = lineFloors(cmd, segs, env);
      return h ? blocked(h) : undefined;
    }
    if (PATH_TOOLS.has(toolName)) {
      const h = pathFloors(inp, env);
      return h ? blocked(h) : undefined;
    }
    return undefined;
  } catch (e) {
    return { block: true, rule: "gate-error", reason: `pi-foreman: the permission gate failed (${e instanceof Error ? e.message : String(e)}), so the call is denied. Report this to the user.` };
  }
}

/** The default floor environment: process facts only. index.ts passes richer roots when it wires the session in. */
export function baseFloorEnv(cwd: string, extra: Partial<FloorEnv> = {}): FloorEnv {
  return { cwd, home: os.homedir(), platform: process.platform, writeRoots: [cwd, os.tmpdir(), "/tmp"], ...extra };
}
