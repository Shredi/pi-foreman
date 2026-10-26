// The R41 gate: the single tool_call decision point. Pipeline: parse -> floors -> selfmod -> defaults -> path rules -> review -> dialog
// per session kind -> log. This module is the synchronous part (floors, selfmod, defaults, path rules); index.ts adds review, dialog and
// log for a call it returns undefined for. Shell, path and payload tools all pass through here. A handler failure denies (fail-safe).
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import { lineDefault, toolDefault } from "./defaults.ts";
import type { GitFacts } from "./defaults.ts";
import { lineFloors, opaqueTextFloors, pathFloors, rawFloors, secretPath, type FloorEnv, type FloorHit } from "./floors.ts";
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

/**
 * Tools whose payload is prose for another agent or the user (a builder brief may say "never use sudo"): the raw-text floors do NOT run
 * on their prose fields, only the structured fields below are floored; the whole payload then goes to review.
 */
const PROSE_TOOLS = new Set(["subagent", "intercom", "contact_supervisor", "subagent_supervisor", "ask_user_question"]);
const STRUCTURED_PATH_KEYS = ["cwd", "worktree", "output", "outputPath", "output_path", "outputFile"];

/** Every string leaf of a JSON value, one per line (so a floor regex sees `rm -rf /` as the line it is, not as JSON). */
function stringLeaves(v: unknown, out: string[] = [], depth = 0): string[] {
  if (typeof v === "string") out.push(v);
  else if (depth < 8 && v && typeof v === "object") for (const x of Object.values(v)) stringLeaves(x, out, depth + 1);
  return out;
}

/** Floors for a tool that is neither shell nor path: structured path fields for prose tools, raw-text floors on the payload for the rest. */
function payloadFloors(tool: string, inp: Record<string, unknown>, env: FloorEnv): FloorHit | null {
  if (PROSE_TOOLS.has(tool)) {
    for (const k of STRUCTURED_PATH_KEYS) {
      const v = inp[k];
      const h = typeof v === "string" && v ? secretPath(v, env) : null;
      if (h) return h;
    }
    return null;
  }
  // the leaves as one text, then each quote- or line-delimited piece (`sh('rm -rf /')` in code is the text `rm -rf /`). Raw-text floors only:
  // segment floors (secret paths) stay with the inner calls of codemode, which the gate decides one by one.
  const leaves = stringLeaves(inp);
  const text = leaves.join("\n");
  if (!text) return null;
  const hit = rawFloors(text) ?? opaqueTextFloors(text, env);
  if (hit) return hit;
  for (const piece of leaves.flatMap((l) => l.split(/[\n'"`]/)).map((p) => p.trim()).filter(Boolean)) {
    const h = rawFloors(piece) ?? opaqueTextFloors(piece, env);
    if (h) return h;
  }
  return null;
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
    const ph = payloadFloors(toolName, inp, env);
    if (ph) return blocked(ph);
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
