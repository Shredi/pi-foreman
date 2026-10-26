// The R41 gate: the single tool_call decision point. Slice 2: parse -> floors -> path rules and defaults. A call that is neither
// blocked nor a default continues into the handlers that exist today (review, dialog and log come in later slices), so nothing is
// loosened. A handler failure denies (fail-safe).
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import { lineDefault, toolDefault } from "./defaults.ts";
import type { GitFacts } from "./defaults.ts";
import { lineFloors, pathFloors, type FloorEnv, type FloorHit } from "./floors.ts";
import { PATH_TOOL_NAMES, pathDecide } from "./pathrules.ts";
import { pathSelfmod, shellSelfmod, type SelfmodHit } from "./selfmod.ts";
import type { GateRoots } from "./pathrules.ts";
import { parseShell } from "./shellast.ts";
import type { ShellSegment } from "./shellast.ts";

export interface GateDeps {
  /** The floor environment for the call's cwd (roots, protected branches, git lookups). */
  env: (cwd: string) => FloorEnv;
  /** The session's roots for the path rules and defaults; without them the gate applies floors only. */
  roots?: (cwd: string) => GateRoots;
  /** Git facts for the push and switch defaults (default: real git lookups). */
  facts?: GitFacts;
}

/** `ask`: a self-modification rule (selfmod.ts) wants the dialog / ask path; never a model call. */
export type GateResult = { block: true; reason: string; rule: string } | { allow: true; rule: string } | { ask: true; rule: string; reason: string } | undefined;

const SHELL_TOOLS = new Set(["bash", "foreman_bg", "bg_run"]);
const PATH_TOOLS = PATH_TOOL_NAMES;

const blocked = (h: FloorHit): GateResult => ({ block: true, reason: h.reason, rule: h.rule });

/** A self-modification hit: a child is denied outright (with what to report), every other session kind is asked. */
function selfmodResult(h: SelfmodHit | undefined, child: boolean): GateResult {
  if (!h) return undefined;
  if (child) return { block: true, rule: h.rule, reason: `pi-foreman: self-modification rule ${h.rule}: ${h.reason}. Children cannot make this change; report this line to the foreman and continue with what you can.` };
  return { ask: true, rule: h.rule, reason: h.reason };
}

/** The command text of a shell-like tool call, or null. */
function commandOf(toolName: string, input: Record<string, unknown>): string | null {
  if (!SHELL_TOOLS.has(toolName) && toolName !== "powershell") return null;
  const c = input.command ?? input.cmd;
  return typeof c === "string" ? c : null;
}

/** The powershell tool is one opaque segment: raw-text floors apply, it is never a default. */
function powershellSegment(cwd: string): ShellSegment {
  return { program: "powershell", argv: [], redirects: [], heredoc: false, cwd, wrappers: [], opaque: "foreign_shell" };
}

export function gateDecide(toolName: string, input: unknown, cwd: string, deps: GateDeps): GateResult {
  try {
    const inp = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const env = deps.env(cwd);
    const platform = env.platform ?? process.platform;
    const cmd = commandOf(toolName, inp);
    if (cmd !== null) {
      const segs = toolName === "powershell" ? [powershellSegment(cwd)] : parseShell(cmd, { cwd, platform: env.platform });
      const h = lineFloors(cmd, segs, env);
      if (h) return blocked(h);
      if (!deps.roots || toolName === "powershell") return undefined;
      const sm = selfmodResult(shellSelfmod(segs, cwd, deps.roots(cwd), platform), deps.roots(cwd).child);
      if (sm) return sm;
      const rule = lineDefault(cmd, segs, { roots: deps.roots(cwd), facts: deps.facts ?? gitFacts, platform, cwd });
      return rule ? { allow: true, rule } : undefined;
    }
    if (PATH_TOOLS.has(toolName)) {
      const h = pathFloors(inp, env, toolName);
      if (h) return blocked(h);
      if (deps.roots) {
        const sm = selfmodResult(pathSelfmod(toolName, inp, cwd, deps.roots(cwd), platform), deps.roots(cwd).child);
        if (sm) return sm;
      }
      const v = deps.roots ? pathDecide(toolName, inp, cwd, deps.roots(cwd), platform) : undefined;
      return v;
    }
    const rule = toolDefault(toolName, inp);
    return rule ? { allow: true, rule } : undefined;
  } catch (e) {
    return { block: true, rule: "gate-error", reason: `pi-foreman: the permission gate failed (${e instanceof Error ? e.message : String(e)}), so the call is denied. Report this to the user.` };
  }
}

// ------------------------------------------------------------------ git lookups

/** Trimmed stdout of `git <args>` in `cwd`, or null on any failure. */
function gitOut(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const currentBranch = (cwd: string): string | null => gitOut(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]) || null;
const remoteHead = (cwd: string): string | null => gitOut(cwd, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"])?.replace(/^origin\//, "") || null;

/** The real git lookups for the push and switch defaults. `protectedBranches` joins the config list in index.ts. */
export const gitFacts: GitFacts = {
  currentBranch,
  protectedBranches: (cwd) => ["main", "master", ...(remoteHead(cwd) ? [remoteHead(cwd) as string] : [])],
  pushConfigured: (cwd) => {
    try {
      return execFileSync("git", ["config", "--get-regexp", "^(remote\\..*\\.push|remote\\.pushDefault|branch\\..*\\.pushRemote)$"], { cwd, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim() !== "";
    } catch (e) {
      return (e as { status?: number }).status !== 1; // exit 1 = no such key; any other failure counts as configured (fail closed)
    }
  },
};

/** Git facts for a review request: branch, HEAD, MERGE_HEAD and remote names (null / empty when git cannot say). */
export function reviewGitFacts(cwd: string): { branch: string | null; head: string | null; mergeHead: string | null; remotes: string[] } {
  return {
    branch: currentBranch(cwd),
    head: gitOut(cwd, ["rev-parse", "-q", "--verify", "HEAD"]) || null,
    mergeHead: gitOut(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]) || null,
    remotes: (gitOut(cwd, ["remote"]) ?? "").split("\n").filter(Boolean),
  };
}

const PURE_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const PURE_READ_RULES = new Set(["default-read", "default-git-read", "default-gh-read", "default-fetch"]);

/** Whether an allowed call can change state (so cached review allows no longer hold): everything but a pure read. */
export function changesState(tool: string, rule?: string): boolean {
  if (PURE_READ_TOOLS.has(tool) || (rule !== undefined && PURE_READ_RULES.has(rule))) return false;
  return !(rule !== undefined && /^path-read-/.test(rule));
}

/** The default floor environment: process facts and git lookups. index.ts passes richer roots when it wires the session in. */
export function baseFloorEnv(cwd: string, extra: Partial<FloorEnv> = {}): FloorEnv {
  return { cwd, home: os.homedir(), platform: process.platform, writeRoots: [cwd, os.tmpdir(), "/tmp"], currentBranch, remoteHead, ...extra };
}
