// Environment for core script runs and for Pi's shell tools.
import * as path from "node:path";
import type { GuardName } from "./toolmap.ts";

export type Env = Record<string, string | undefined>;

// Another harness's settings must never reach the core through pi-foreman: these switch
// guards off (DESTRUCTIVE_GUARD=0, LEDGER_WRITE_GUARD=0, FABLE_ORCH_MODE=plain), point the
// ledger elsewhere (LEDGER) or carry a foreign session id (CLAUDE_CODE_SESSION_ID).
const STRIP_PREFIXES = ["CLAUDE_", "FABLE_ORCH_", "LEDGER_"];
const STRIP_EXACT = new Set(["LEDGER", "DESTRUCTIVE_GUARD", "SAFE_RM_DRYRUN", "SAFE_RM_BYPASS", "TMPDIR"]);

export function isStrippedKey(key: string): boolean {
  const k = key.toUpperCase();
  return STRIP_EXACT.has(k) || STRIP_PREFIXES.some((p) => k.startsWith(p));
}

export interface GuardEnvInput {
  base: Env;
  /** `<package>/core`. Session binding (no legacy discovery) is switched on by FABLE_ORCH_SESSION_BINDING=1. */
  coreDir: string;
  sessionId: string;
  guard: GuardName;
  /** Directory holding the session marker and sidecars (TMPDIR for the ledger scripts). */
  markerDir: string;
  /** LEDGER_GUARD_THRESHOLD for the spawn gate; null keeps the core default. */
  threshold?: number | null;
}

export function buildGuardEnv(input: GuardEnvInput): Record<string, string> {
  const out: Record<string, string> = {};
  let tmpdirHost: string | undefined;
  for (const [key, value] of Object.entries(input.base)) {
    if (value === undefined) continue;
    if (key.toUpperCase() === "TMPDIR") tmpdirHost = value;
    if (isStrippedKey(key)) continue;
    out[key] = value;
  }
  out.FABLE_ORCH_HARNESS = "pi";
  out.FABLE_ORCH_SESSION_BINDING = "1";
  out.CLAUDE_CODE_SESSION_ID = input.sessionId;
  out.PI_SESSION_ID = input.sessionId;
  // Core metrics go into pi-foreman's state dir, never another harness's folder.
  out.FABLE_ORCH_METRICS_DIR = input.markerDir;
  // Claude-only duties of the stop hook: tmux teammate reaping and the `ps` walk.
  out.FABLE_ORCH_SWARM_CLEANUP = "0";
  out.FABLE_ORCH_TEAMMATE_STOP = "1";
  if (input.guard === "destructive_guard") {
    // The destructive guard treats the temp dir as an allowed root: keep the host's.
    if (tmpdirHost !== undefined) out.TMPDIR = tmpdirHost;
  } else {
    // Python's tempfile checks TMPDIR first on every OS: marker, task and stop sidecars.
    out.TMPDIR = input.markerDir;
  }
  if (input.guard === "ledger_guard_spawn" && typeof input.threshold === "number") {
    out.LEDGER_GUARD_THRESHOLD = String(Math.max(0, Math.floor(input.threshold)));
  }
  return out;
}

export interface ShellPatchInput {
  env: Env;
  binDir: string;
  python: string | null;
  markerDir: string;
  delimiter?: string;
}

/**
 * Make `ledger` reachable from Pi's bash and powershell tools. Both build their env from
 * process.env at each command start (Pi utils/shell.js getShellEnv), so patching the
 * process env is enough. Idempotent.
 */
export function patchShellEnv(input: ShellPatchInput): void {
  const delim = input.delimiter ?? path.delimiter;
  const env = input.env;
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const entries = (env[pathKey] ?? "").split(delim).filter(Boolean);
  if (!entries.includes(input.binDir)) env[pathKey] = [input.binDir, ...entries].join(delim);
  if (input.python) env.PI_FOREMAN_PYTHON = input.python;
  env.PI_FOREMAN_STATE_DIR = input.markerDir;
}

/** Pi agent dir: PI_CODING_AGENT_DIR (tilde expanded) or ~/.pi/agent (Pi config.js getAgentDir). */
export function piAgentDir(env: Env, home: string): string {
  const raw = env.PI_CODING_AGENT_DIR;
  if (raw) {
    if (raw === "~") return home;
    if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(home, raw.slice(2));
    return raw;
  }
  return path.join(home, ".pi", "agent");
}
