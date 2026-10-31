// The gate's synchronous decision (r79 item 3). Pipeline: parse -> floors -> selfmod -> deny rules -> ask rules -> allow rules and built-in
// allows -> dangerous class; index.ts adds the mode step (classifier, dialog, deny) and the log for what is left. A floor of kind `deny` blocks; a floor
// of kind `ask` (opaque-text word match) and a self-modification rule go to the owner before the mode step, behind the deny and ask rules. Shell,
// path and payload tools all pass through here. A handler failure denies (fail-safe).
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import { OWN_TOOLS, createsPullRequest, dangerMatch, effectCtxOf, segmentDefault, toolDefault, writesOutside } from "./defaults.ts";
import type { DangerHit, GitFacts } from "./defaults.ts";
import { lineFloors, opaqueTextFloors, pathFloors, rawFloors, secretPath, type FloorEnv, type FloorHit } from "./floors.ts";
import { PATH_TOOL_NAMES, pathDecide } from "./pathrules.ts";
import { matchRules, ruleCallOf } from "./rules.ts";
import type { RuleCall, RuleEnv, RuleSets, RuleVerdict } from "./rules.ts";
import { pathSelfmod, shellSelfmod, type SelfmodHit } from "./selfmod.ts";
import type { GateRoots } from "./pathrules.ts";
import { parseShell } from "./shellast.ts";
import type { ShellSegment } from "./shellast.ts";
import { webReadAllow } from "./webread.ts";

export interface GateDeps {
  /** The floor environment for the call's cwd (roots, protected branches, git lookups). */
  env: (cwd: string) => FloorEnv;
  /** The session's roots for the path rules and defaults; without them the gate applies floors only. */
  roots?: (cwd: string) => GateRoots;
  /** Git facts for the push and switch defaults (default: real git lookups). */
  facts?: GitFacts;
  /** The merged pattern rules and their environment (permconfig `Resolved.rules`); absent: no pattern rules. */
  rules?: { sets: RuleSets; env: RuleEnv };
}

/** What asks the owner before the mode step: a self-modification rule, an ask-kind floor hit (opaque text), a pattern `ask` rule. */
export type AskCause = "selfmod" | "floor" | "rule";

/**
 * `block`: a floor or a deny rule. `allow`: a built-in allow or an allow rule. `ask`: the dialog / ask path, never a model call and never run under
 * mode `allow`. undefined: nothing decided here.
 */
export type GateResult =
  | { block: true; reason: string; rule: string; layer?: "floor" | "rule" }
  | { allow: true; rule: string; layer?: "default" | "rule" }
  | { ask: true; rule: string; reason: string; cause?: AskCause }
  | undefined;

const SHELL_TOOLS = new Set(["bash", "foreman_bg", "bg_run"]);
const PATH_TOOLS = PATH_TOOL_NAMES;

const blocked = (h: FloorHit): GateResult => ({ block: true, reason: h.reason, rule: h.rule, layer: "floor" });
const askFromFloor = (h: FloorHit): GateResult => ({ ask: true, rule: h.rule, reason: h.reason, cause: "floor" });

/** A self-modification hit: a child is denied outright (with what to report), every other session kind is asked. */
function selfmodResult(h: SelfmodHit | undefined, child: boolean): GateResult {
  if (!h) return undefined;
  if (child) return { block: true, rule: h.rule, layer: "floor", reason: `pi-foreman: self-modification rule ${h.rule}: ${h.reason}. Children cannot make this change; report this line to the foreman and continue with what you can.` };
  return { ask: true, rule: h.rule, reason: h.reason, cause: "selfmod" };
}

/**
 * The child deny set (r79 item 2; marked `childDeny` in the launch binding): a child never writes outside its worktree and its own scratch dir, and never
 * opens a pull or merge request (the foreman does). It runs before the deny rules, allow rules, built-in allows, classifier and mode step, so no allow rule,
 * classifier verdict or mode lifts it. The child floors and self-modification rules run before it.
 */
function childDenied(tool: string, input: unknown, segments: ShellSegment[] | undefined, cmd: string | null, env: { roots: GateRoots; platform: string; cwd: string; facts: GitFacts }): GateResult {
  const deny = (rule: string, what: string): GateResult => ({ block: true, rule, layer: "floor", reason: `pi-foreman: denied for child sessions (${rule}): ${what} Report what you need to the foreman and continue with what you can.` });
  if (tool === "pr_create" || (segments && createsPullRequest(segments))) return deny("child-pr-create", "Children never open a pull or merge request; the foreman does.");
  const call = segments ? { tool, input, segments, ...(cmd !== null ? { text: cmd } : {}) } : { tool, input };
  if (writesOutside(call, env)) return deny("child-write-outside", "Children write only inside their own worktree and their scratch dir ($FOREMAN_SCRATCH), never the parent's checkout, .workflow/ or other directories.");
  return undefined;
}

/** The command text of a shell-like tool call, or null. */
function commandOf(toolName: string, input: Record<string, unknown>): string | null {
  if (!SHELL_TOOLS.has(toolName) && toolName !== "powershell") return null;
  const c = input.command ?? input.cmd;
  return typeof c === "string" ? c : null;
}

/** The powershell tool is one opaque segment: raw-text floors apply, it is never a built-in allow. */
function powershellSegment(cwd: string): ShellSegment {
  return { program: "powershell", argv: [], redirects: [], heredoc: false, cwd, wrappers: [], opaque: "foreign_shell" };
}

/**
 * Tools whose payload is prose for another agent or the user (a builder brief may say "never use sudo"): the raw-text floors do NOT run
 * on their prose fields, only the structured fields below are floored.
 */
const PROSE_TOOLS = new Set(["subagent", "intercom", "contact_supervisor", "subagent_supervisor", "ask_user_question", "pr_create"]);
const STRUCTURED_PATH_KEYS = ["cwd", "worktree", "output", "outputPath", "output_path", "outputFile"];

/** Every string leaf of a JSON value, one per line (so a floor regex sees `rm -rf /` as the line it is, not as JSON). */
function stringLeaves(v: unknown, out: string[] = [], depth = 0): string[] {
  if (typeof v === "string") out.push(v);
  else if (depth < 8 && v && typeof v === "object") for (const x of Object.values(v)) stringLeaves(x, out, depth + 1);
  return out;
}

/** Free-text fields of pi-foreman's own tools (notes, plans, messages, PR text, dialog questions): quoting a floored command there is prose, not a command. */
const PROSE_FIELDS = new Set(["text", "note", "notes", "plan", "message", "reason", "question", "questions", "title", "body", "summary", "answer", "description", "details", "detail", "content", "findings", "comment", "prompt", "context", "label", "options", "report"]);
/** Fields that name a file or directory: a secret path there is a floor deny. */
const PATH_FIELD = /^(?:path|paths|cwd|worktree|file|files|dir|dirs|directory|target|dest|destination|src|source|from|to|root|repo|output|outputPath|output_path|outputFile)$/i;

/**
 * Floors on the fields of a structured payload: secretPath on path-like fields; with `raw`, raw-text floors on every other string field except the
 * prose fields (own tools). Floors are permanent, so only free text is exempt, never a whole tool.
 */
function fieldFloors(v: unknown, key: string, env: FloorEnv, raw: boolean, depth = 0): FloorHit | null {
  if (raw && PROSE_FIELDS.has(key)) return null;
  if (typeof v === "string") {
    if (!v) return null;
    if (PATH_FIELD.test(key)) return secretPath(v, env);
    return raw ? (rawFloors(v) ?? opaqueTextFloors(v, env)) : null;
  }
  let found: FloorHit | null = null;
  if (depth < 8 && v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      const h = fieldFloors(x, Array.isArray(v) ? key : k, env, raw, depth + 1);
      if (h?.kind === "deny") return h;
      found = found ?? h;
    }
  }
  return found;
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
  const pathHit = fieldFloors(inp, "", env, false);
  if (pathHit) return pathHit;
  const leaves = stringLeaves(inp);
  const text = leaves.join("\n");
  if (!text) return null;
  let found: FloorHit | null = null;
  const hit = rawFloors(text) ?? opaqueTextFloors(text, env);
  if (hit?.kind === "deny") return hit;
  found = hit;
  for (const piece of leaves.flatMap((l) => l.split(/[\n'"`]/)).map((p) => p.trim()).filter(Boolean)) {
    const h = rawFloors(piece) ?? opaqueTextFloors(piece, env);
    if (h?.kind === "deny") return h;
    found = found ?? h;
  }
  return found;
}

/** What a gate evaluation found: the synchronous result, the dangerous-class entry when nothing decided, and the parse. */
export interface GateOutcome {
  /** floor / selfmod / rule / built-in decision; undefined = nothing decided (the dangerous class and the mode step follow). */
  result: GateResult;
  /** Set only when `result` is undefined, the gate has roots and the call falls into the dangerous class. */
  danger: DangerHit | null;
  /** The parse of a shell tool's line (proposeRule reads it). */
  segments?: ShellSegment[];
}

const baseProg = (p: string): string => (p.split(/[\\/]/).pop() ?? p).toLowerCase().replace(/\.exe$/, "");

/** The name of the built-in allow of a plain download (`webReadAllow`, r79 Addendum S5). */
export const WEB_READ_RULE = "builtin-web-read";

/** The layer an allow name belongs to: built-in names are `default-*`, `path-*`, `builtin-*`; anything else is a pattern rule. */
const allowLayer = (rule: string): "default" | "rule" => (rule.split("+").every((n) => /^(?:default-|path-|builtin-)/.test(n)) ? "default" : "rule");

function ruleResult(v: RuleVerdict): GateResult {
  if (v.verdict === "deny") return { block: true, rule: `rule ${v.rule}`, layer: "rule", reason: `pi-foreman: denied by the permission rule ${v.rule}.` };
  if (v.verdict === "ask") return { ask: true, rule: `rule ${v.rule}`, reason: `the permission rule ${v.rule} asks`, cause: "rule" };
  if (v.verdict === "allow") return { allow: true, rule: v.rule, layer: allowLayer(v.rule) };
  return undefined;
}

/**
 * The gate's synchronous decision: parse -> floors (a deny blocks; an ask-kind hit waits behind the rules) -> selfmod -> deny rules -> ask rules ->
 * the floor ask -> allow rules and built-in allows -> dangerous class. The caller applies the mode step to what is left.
 */
export function gateEvaluate(toolName: string, input: unknown, cwd: string, deps: GateDeps): GateOutcome {
  try {
    const inp = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const env = deps.env(cwd);
    const platform = env.platform ?? process.platform;
    const roots = deps.roots?.(cwd);
    const facts = deps.facts ?? gitFacts;
    const home = env.home ?? os.homedir();
    const rules = deps.rules ?? { sets: { deny: [], ask: [], allow: [] }, env: { cwd, home, platform, checkout: cwd } };
    const callCtx = (segments?: ShellSegment[]) => ({ cwd, home, platform, ...(segments ? { segments } : {}) });
    const decided = (result: GateResult): GateOutcome => ({ result, danger: null });
    /** deny rules and ask rules, then a pending floor ask, then allow rules and the built-in allow `builtin`. */
    const ruled = (call: RuleCall, pending: FloorHit | null, builtin: (unit: number) => string | null): GateResult => {
      const first = matchRules({ deny: rules.sets.deny, ask: rules.sets.ask, allow: [] }, call, rules.env);
      if (first.verdict === "deny" || first.verdict === "ask") return ruleResult(first);
      if (pending) return askFromFloor(pending);
      return ruleResult(matchRules(rules.sets, call, rules.env, builtin));
    };

    const cmd = commandOf(toolName, inp);
    if (cmd !== null) {
      const segs = toolName === "powershell" ? [powershellSegment(cwd)] : parseShell(cmd, { cwd, platform: env.platform });
      const h = lineFloors(cmd, segs, env);
      if (h && h.kind === "deny") return decided(blocked(h));
      if (!roots) return decided(h ? askFromFloor(h) : undefined);
      if (toolName !== "powershell") {
        const sm = selfmodResult(shellSelfmod(segs, cwd, roots, platform), roots.child);
        if (sm) return decided(sm);
      }
      const dctx = { roots, facts, platform, cwd };
      if (roots.child && toolName !== "powershell") {
        const cd = childDenied(toolName, inp, segs, cmd, dctx);
        if (cd) return decided(cd);
      }
      const ec = effectCtxOf(dctx);
      const web = webReadAllow(toolName, inp, { cwd, scratch: roots.scratch, platform });
      const builtin = (i: number): string | null => {
        const s = segs[i];
        if (!s || toolName === "powershell") return null;
        const r = segmentDefault(s, cmd, dctx, ec);
        if (r !== null) return r;
        return web.candidate && web.ok && (baseProg(s.program) === "curl" || baseProg(s.program) === "wget") ? WEB_READ_RULE : null;
      };
      const result = ruled(ruleCallOf(toolName, inp, callCtx(segs)), h, builtin);
      if (result) return { result, danger: null, segments: segs };
      return { result: undefined, danger: dangerMatch({ tool: toolName, input: inp, segments: segs, text: cmd }, { roots, platform, cwd, facts }), segments: segs };
    }
    if (PATH_TOOLS.has(toolName)) {
      const h = pathFloors(inp, env, toolName);
      if (h && h.kind === "deny") return decided(blocked(h));
      if (!roots) return decided(h ? askFromFloor(h) : undefined);
      const sm = selfmodResult(pathSelfmod(toolName, inp, cwd, roots, platform), roots.child);
      if (sm) return decided(sm);
      if (roots.child) {
        const cd = childDenied(toolName, inp, undefined, null, { roots, facts, platform, cwd });
        if (cd) return decided(cd);
      }
      const pv = pathDecide(toolName, inp, cwd, roots, platform);
      const result = ruled(ruleCallOf(toolName, inp, callCtx()), h, () => (pv ? pv.rule : null));
      if (result) return decided(result);
      return { result: undefined, danger: dangerMatch({ tool: toolName, input: inp }, { roots, platform, cwd, facts }) };
    }
    // own tools carry free text (ledger notes, plans) that may quote a floor pattern: only their prose fields skip the floors
    const ph = OWN_TOOLS.has(toolName) ? fieldFloors(inp, "", env, true) : payloadFloors(toolName, inp, env);
    if (ph && ph.kind === "deny") return decided(blocked(ph));
    if (!roots) return decided(ph ? askFromFloor(ph) : undefined);
    if (roots.child) {
      const cd = childDenied(toolName, inp, undefined, null, { roots, facts, platform, cwd });
      if (cd) return decided(cd);
    }
    const web = toolName === "fetch" ? webReadAllow(toolName, inp, { cwd, scratch: roots.scratch, platform }) : null;
    const builtinRule = toolDefault(toolName, inp, { child: roots.child, roots, cwd, platform }) ?? (web && web.candidate && web.ok ? WEB_READ_RULE : undefined);
    const result = ruled(ruleCallOf(toolName, inp, callCtx()), ph, () => builtinRule ?? null);
    if (result) return decided(result);
    return { result: undefined, danger: dangerMatch({ tool: toolName, input: inp }, { roots, platform, cwd, facts }) };
  } catch (e) {
    return { result: { block: true, rule: "gate-error", layer: "floor", reason: `pi-foreman: the permission gate failed (${e instanceof Error ? e.message : String(e)}), so the call is denied. Report this to the user.` }, danger: null };
  }
}

/** The result of `gateEvaluate` alone (floors, selfmod, rules, built-in allows). */
export function gateDecide(toolName: string, input: unknown, cwd: string, deps: GateDeps): GateResult {
  return gateEvaluate(toolName, input, cwd, deps).result;
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
  ownBranches: (cwd) => {
    // `git worktree list --porcelain`: the first block is the main checkout, every later one a linked worktree (made by `git worktree add`)
    const blocks = (gitOut(cwd, ["worktree", "list", "--porcelain"]) ?? "").split(/\n\s*\n/).slice(1);
    return blocks.flatMap((b) => {
      const m = /^branch refs\/heads\/(.+)$/m.exec(b);
      return m ? [m[1]] : [];
    });
  },
  hasUpstream: (cwd) => gitOut(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]) !== null,
};

/** Git facts for a classifier request: branch, HEAD, MERGE_HEAD and remote names (null / empty when git cannot say). */
export function reviewGitFacts(cwd: string): { branch: string | null; head: string | null; mergeHead: string | null; remotes: string[] } {
  return {
    branch: currentBranch(cwd),
    head: gitOut(cwd, ["rev-parse", "-q", "--verify", "HEAD"]) || null,
    mergeHead: gitOut(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]) || null,
    remotes: (gitOut(cwd, ["remote"]) ?? "").split("\n").filter(Boolean),
  };
}

/** The default floor environment: process facts and git lookups. index.ts passes richer roots when it wires the session in. */
export function baseFloorEnv(cwd: string, extra: Partial<FloorEnv> = {}): FloorEnv {
  return { cwd, home: os.homedir(), platform: process.platform, writeRoots: [cwd, os.tmpdir(), "/tmp"], currentBranch, remoteHead, ...extra };
}
