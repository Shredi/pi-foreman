// The gate's synchronous decision (r79 item 3). Pipeline: parse -> floors -> selfmod -> deny rules -> ask rules -> allow rules and built-in
// allows -> dangerous class; index.ts adds the mode step (classifier, dialog, deny) and the log for what is left. A floor of kind `deny` blocks; a floor
// of kind `ask` (opaque-text word match) and a self-modification rule go to the owner before the mode step, behind the deny and ask rules. Shell,
// path and payload tools all pass through here. A handler failure denies (fail-safe).
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import { DANGER_RULES, OWN_TOOLS, createsPullRequest, dangerMatch, effectCtxOf, outsideTarget, segmentDefault, toolDefault, writesIntoCheckout, writesOutside } from "./defaults.ts";
import type { DangerHit, GitFacts } from "./defaults.ts";
import { PATH_KEYS, READ_PATH_TOOLS, cutFragment, lineFloors, opaqueTextFloors, pathFloors, pubKeyReadWords, rawFloors, realDeep, secretPath, sshPublicKey, type FloorEnv, type FloorHit } from "./floors.ts";

/** The trace/log rule of a read that only an SSH public key in ~/.ssh made pass the floors (floors.ts sshPublicKey). */
const PUBKEY_READ_RULE = "floor-pubkey-read";
import { PATH_TOOL_NAMES, pathDecide } from "./pathrules.ts";
import { boundNames, relaxPatternWords } from "./permoverlay.ts";
import { matchRules, readFieldOf, ruleCallOf } from "./rules.ts";
import type { ReadToolMap, RuleCall, RuleEnv, RuleSets, RuleVerdict } from "./rules.ts";
import { pathSelfmod, shellSelfmod, type SelfmodHit } from "./selfmod.ts";
import type { GateRoots } from "./pathrules.ts";
import { parseShell } from "./shellast.ts";
import type { ShellSegment } from "./shellast.ts";
import { webReadAllow } from "./webread.ts";
import { matchProtected } from "./protected.ts";
import type { ProtectedMatch } from "./protected.ts";
import type { ProtectedEntry } from "./permconfig.ts";

export interface GateDeps {
  /** The floor environment for the call's cwd (roots, protected branches, git lookups). */
  env: (cwd: string) => FloorEnv;
  /** The session's roots for the path rules and defaults; without them the gate applies floors only. */
  roots?: (cwd: string) => GateRoots;
  /** Git facts for the push and switch defaults (default: real git lookups). */
  facts?: GitFacts;
  /** The merged pattern rules and their environment (permconfig `Resolved.rules`); absent: no pattern rules. */
  rules?: { sets: RuleSets; env: RuleEnv };
  /** `gate.readTools`: extension tool name -> path field (null: none); judged like read/grep (Read rules, path floors, owned-path allows). */
  readTools?: ReadToolMap;
  /** The merged protected targets (permconfig `Resolved.protected`); absent or empty: no protected check. */
  protected?: ProtectedEntry[];
  /** `floors.noteTools` of the owner's permissions file (`Resolved.noteTools`): note tools by name, added to `NOTE_TOOLS`; their prose fields skip the raw floors. */
  noteTools?: readonly string[];
}

/**
 * Note tools of the public `pi-memory` package (`scratchpad` takes its note in `text`, `memory_write` in `content`): their prose fields are notes, not commands.
 * The owner's `floors.noteTools` adds to this list; it goes by tool name.
 */
export const NOTE_TOOLS: ReadonlySet<string> = new Set(["scratchpad", "memory_write"]);

/** pi-foreman tools outside OWN_TOOLS whose prose fields (the note's markdown, the session brief) are text for a reader: prose fields skip the raw floors, every other field keeps them. */
const PROSE_FIELD_TOOLS = new Set(["foreman_show", "foreman_session_open"]);

/** What asks the owner before the mode step: a self-modification rule, an ask-kind floor hit (opaque text), a pattern `ask` rule, a protected-target match. */
export type AskCause = "selfmod" | "floor" | "rule" | "protected";

/**
 * `block`: a floor or a deny rule. `allow`: a built-in allow or an allow rule. `ask`: the dialog / ask path, never a model call and never run under
 * mode `allow`. undefined: nothing decided here.
 */
export type GateResult =
  | { block: true; reason: string; rule: string; layer?: "floor" | "rule" }
  | { allow: true; rule: string; layer?: "default" | "rule" }
  | { ask: true; rule: string; reason: string; cause?: AskCause; match?: ProtectedMatch }
  | undefined;

// cause "protected" is the one ask that runs a model first (the protected-target check in index.ts); `match` carries what the check judges.
const SHELL_TOOLS = new Set(["bash", "foreman_bg", "bg_run"]);
const PATH_TOOLS = PATH_TOOL_NAMES;

const fragments = new WeakMap<object, string>();
const sentences = new WeakMap<object, string>();

/** The matched fragment of a floor denial (the `matched:` part of its reason), for the gate log; the result object keeps its shape. */
export const denialFragment = (r: GateResult): string | undefined => (r ? fragments.get(r) : undefined);

/** The floor's own sentence of a floor denial (without the appended tool and fragment), else the reason: what the child repeat stop counts. */
export const denialSentence = (r: { reason: string }): string => sentences.get(r) ?? r.reason;

/** A floor denial: the floor's sentence unchanged, then the tool and the matched fragment (the agent's text after redaction, cut to 80 characters). */
const blocked = (h: FloorHit, tool: string): GateResult => {
  const r: GateResult = { block: true, reason: `${h.reason} (tool: ${cutFragment(tool)}${h.fragment ? `; matched: ${h.fragment}` : ""})`, rule: h.rule, layer: "floor" };
  if (h.fragment) fragments.set(r, h.fragment);
  sentences.set(r, h.reason);
  return r;
};
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
  if (tool === "foreman_protect") return deny("child-protect", "Children never change the protected targets; the owner does, with /foreman perms protect.");
  if (tool === "pr_create" || (segments && createsPullRequest(segments))) return deny("child-pr-create", "Children never open a pull or merge request; the foreman does.");
  const call = segments ? { tool, input, segments, ...(cmd !== null ? { text: cmd } : {}) } : { tool, input };
  if (writesOutside(call, env) && writesIntoCheckout(call, env)) return deny("child-write-foreman-checkout", "Children never write the foreman's checkout or its .workflow/ (the foreman's files change through the foreman); write inside your own worktree and your scratch dir ($FOREMAN_SCRATCH).");
  const outside = outsideTarget(call, env);
  if (outside !== null) {
    const r = env.roots;
    const scratch = r.scratch.length ? `the scratch dir ${r.scratch.join(", ")}` : "no scratch dir is set";
    const handoff = r.childHandoff ? `the handoff files in ${r.childHandoff} (plan.md, result.md, ask.md, ask-<n>.md, .seen and anything below work/)` : "no handoff dir is set";
    return deny("child-write-outside", `Children write only inside their own worktree and their scratch dir ($FOREMAN_SCRATCH), never the parent's checkout, .workflow/ or other directories. Refused: ${outside}, compared with the worktree root ${r.worktree}. Sanctioned targets: the worktree ${r.worktree}; ${scratch}; ${handoff}.`);
  }
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

/** Every string leaf of a JSON value, one per line (so a floor regex sees `rm -rf /` as the line it is, not as JSON); `skipProse`: leaves under a prose field are left out. */
function stringLeaves(v: unknown, out: string[] = [], depth = 0, skipProse = false, key = ""): string[] {
  if (typeof v === "string") {
    if (!(skipProse && PROSE_FIELDS.has(key))) out.push(v);
  } else if (depth < 8 && v && typeof v === "object") for (const [k, x] of Object.entries(v)) stringLeaves(x, out, depth + 1, skipProse, Array.isArray(v) ? key : k);
  return out;
}

/** Free-text fields of pi-foreman's own tools (notes, plans, messages, PR text, dialog questions): quoting a floored command there is prose, not a command. */
export const PROSE_FIELDS = new Set(["markdown", "brief", "text", "note", "notes", "plan", "message", "reason", "question", "questions", "title", "body", "summary", "answer", "description", "details", "detail", "content", "findings", "comment", "prompt", "context", "label", "options", "report"]);
/** Fields that name a file or directory: a secret path there is a floor deny. */
const PATH_FIELD = /^(?:path|paths|cwd|worktree|file|files|dir|dirs|directory|target|dest|destination|src|source|from|to|root|repo|output|outputPath|output_path|outputFile)$/i;

/**
 * Floors on the fields of a structured payload: secretPath on path-like fields; with `raw`, raw-text floors on every other string field except the
 * prose fields (own tools). Floors are permanent, so only free text is exempt, never a whole tool.
 */
function fieldFloors(v: unknown, key: string, env: FloorEnv, raw: boolean, depth = 0, read = false): FloorHit | null {
  if (raw && PROSE_FIELDS.has(key)) return null;
  if (typeof v === "string") {
    if (!v) return null;
    if (PATH_FIELD.test(key)) return secretPath(v, env, read);
    return raw ? (rawFloors(v) ?? opaqueTextFloors(v, env)) : null;
  }
  let found: FloorHit | null = null;
  if (depth < 8 && v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      const h = fieldFloors(x, Array.isArray(v) ? key : k, env, raw, depth + 1, read);
      if (h?.kind === "deny") return h;
      found = found ?? h;
    }
  }
  return found;
}

/**
 * Floors for a tool that is neither shell nor path: structured path fields for prose tools, raw-text floors on the payload for the rest.
 * `codemode`: its `code` field is not word-matched (its other fields are); the script's tool calls are decided by the gate one by one (they
 * pass `tool_call` as nested calls of the pinned Pi range). `proseExempt`: leaves under a prose field are left out of the raw scan.
 */
function payloadFloors(tool: string, inp: Record<string, unknown>, env: FloorEnv, proseExempt = false): FloorHit | null {
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
  // codemode: the `code` field is not word-matched; every other field keeps the raw floors
  const scanned = tool === "codemode" ? Object.fromEntries(Object.entries(inp).filter(([k]) => k !== "code")) : inp;
  const leaves = stringLeaves(scanned, [], 0, proseExempt);
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

/**
 * A child's own scratch dir in both spellings (the launch binding's and its deepest-existing-ancestor realpath), resolved once when the roots are read:
 * a symlinked temp dir (macOS `/var` -> `/private/var`) makes a literal `cd /private/var/...` write-in. The literal spelling stays first (`$FOREMAN_SCRATCH`).
 * The fence compares the target's real spelling inside the same root (`rootHolds`), so a link out of the dir is still outside. The foreman's checkout
 * (`roots.checkout`, A9) is resolved the same way.
 */
function withRealScratch(roots: GateRoots | undefined): GateRoots | undefined {
  if (!roots?.child) return roots;
  const scratch = [...new Set(roots.scratch.flatMap((d) => [d, realDeep(d) ?? d]))];
  const checkout = roots.checkout ? (realDeep(roots.checkout) ?? roots.checkout) : undefined;
  return scratch.length === roots.scratch.length && checkout === roots.checkout ? roots : { ...roots, scratch, ...(checkout ? { checkout } : {}) };
}

/** What a gate evaluation found: the synchronous result, the dangerous-class entry when nothing decided, and the parse. */
export interface GateOutcome {
  /** floor / selfmod / rule / built-in decision; undefined = nothing decided (the dangerous class and the mode step follow). */
  result: GateResult;
  /** Set only when `result` is undefined, the gate has roots and the call falls into the dangerous class. */
  danger: DangerHit | null;
  /** The parse of a shell tool's line (proposeRule reads it). */
  segments?: ShellSegment[];
  /** A shell line that fell into the dangerous class: the names of every entry it matches (`danger` is the first); the read question's entry condition reads it. */
  dangers?: string[];
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
    const readTools = deps.readTools;
    const rootsBase = withRealScratch(deps.roots?.(cwd));
    const roots = rootsBase && readTools ? { ...rootsBase, readTools } : rootsBase;
    const facts = deps.facts ?? gitFacts;
    const home = env.home ?? os.homedir();
    const rules0 = deps.rules ?? { sets: { deny: [], ask: [], allow: [] }, env: { cwd, home, platform, checkout: cwd } };
    const rules = readTools ? { sets: rules0.sets, env: { ...rules0.env, readTools } } : rules0;
    const effectCtx0 = roots ? effectCtxOf({ roots, platform, cwd }) : undefined;
    const callCtx = (segments?: ShellSegment[]) => ({ cwd, home, platform, ...(segments ? { segments } : {}), ...(readTools ? { readTools } : {}) });
    const decided = (result: GateResult): GateOutcome => ({ result, danger: null });
    /** deny rules and ask rules, then a pending floor ask, then allow rules and the built-in allow `builtin`. */
    const ruled = (call: RuleCall, pending: FloorHit | null, builtin: (unit: number) => string | null, segments?: ShellSegment[]): GateResult => {
      const denied = matchRules({ deny: rules.sets.deny, ask: [], allow: [] }, call, rules.env);
      if (denied.verdict === "deny") return ruleResult(denied);
      if (!pending && deps.protected?.length) {
        const m = matchProtected(call, segments, deps.protected, { ...rules.env, ec: effectCtx0 });
        if (m) {
          const ids = m.entries.map((e) => e.id).join(",");
          return { ask: true, rule: `protected:${ids}`, reason: `the call touches protected target ${m.entries.map((e) => `${e.id} (${e.kind} ${e.glob})`).join(", ")}`, cause: "protected", match: m };
        }
      }
      const first = matchRules({ deny: [], ask: rules.sets.ask, allow: [] }, call, rules.env);
      if (first.verdict === "ask") return ruleResult(first);
      if (pending) return askFromFloor(pending);
      return ruleResult(matchRules(rules.sets, call, rules.env, builtin));
    };

    const cmd = commandOf(toolName, inp);
    if (cmd !== null) {
      // a child's $FOREMAN_SCRATCH is its own scratch dir (set in its process env); without the binding the variable would make every scratch write opaque
      const scratchVar = roots?.child && roots.scratch[0] ? { env: { FOREMAN_SCRATCH: roots.scratch[0] } } : {};
      const parsed = toolName === "powershell" ? [powershellSegment(cwd)] : parseShell(cmd, { cwd, platform: env.platform, ...scratchVar });
      const h = lineFloors(cmd, parsed, env);
      // A8: the floors read the line as written; a grep/rg whose only unknown words are quoted pattern or option values is a read from here on
      const segs = parsed.map(relaxPatternWords);
      if (h && h.kind === "deny") return decided(blocked(h, toolName));
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
      const builtin = (i: number, opaque = false): string | null => {
        const s = segs[i];
        if (!s || toolName === "powershell") return null;
        // an opaque unit (a leading `~` / `$HOME`) gets only the public-key rule, and only when it is a verified read (pubKeyReadWords)
        const r = opaque ? null : segmentDefault(s, cmd, dctx, ec);
        if (r !== null) return r;
        const pubs = pubKeyReadWords([s], env, boundNames(cmd));
        if (pubs.size > 0 && s.argv.every((w) => w.startsWith("-") || pubs.has(w) || w === "/dev/null" || (s.program === "ssh-keygen" && /^(?:md5|sha256)$/.test(w))) && s.redirects.every((x) => x.op === "dup" || x.op === "<" || x.target === "/dev/null")) return PUBKEY_READ_RULE;
        if (opaque) return null;
        return web.candidate && web.ok && (baseProg(s.program) === "curl" || baseProg(s.program) === "wget") ? WEB_READ_RULE : null;
      };
      const result = ruled(ruleCallOf(toolName, inp, callCtx(segs)), h, builtin, segs);
      if (result) return { result, danger: null, segments: segs };
      const dcall = { tool: toolName, input: inp, segments: segs, text: cmd };
      const denv = { roots, platform, cwd, facts };
      const hits = DANGER_RULES.filter((r) => r.test(dcall, denv));
      const danger: DangerHit | null = hits.length ? { name: hits[0].name, reason: hits[0].reason } : null;
      return { result: undefined, danger, segments: segs, ...(hits.length ? { dangers: hits.map((r) => r.name) } : {}) };
    }
    const readField = readFieldOf(readTools, toolName);
    if (PATH_TOOLS.has(toolName) || readField !== undefined) {
      // a mapped tool keeps the payload floors on every other path field (arrays included); `pattern`/`patterns` stay search patterns
      const readOnly = readField !== undefined || READ_PATH_TOOLS.has(toolName);
      const ph0 = pathFloors(inp, env, toolName, readField, readOnly);
      const fh0 = readField !== undefined && ph0?.kind !== "deny" ? fieldFloors(inp, "", env, false, 0, true) : null;
      const h = fh0?.kind === "deny" ? fh0 : (ph0 ?? fh0);
      if (h && h.kind === "deny") return decided(blocked(h, toolName));
      if (!roots) return decided(h ? askFromFloor(h) : undefined);
      const sm = selfmodResult(pathSelfmod(toolName, inp, cwd, roots, platform), roots.child);
      if (sm) return decided(sm);
      if (roots.child) {
        const cd = childDenied(toolName, inp, undefined, null, { roots, facts, platform, cwd });
        if (cd) return decided(cd);
      }
      const pv = pathDecide(toolName, inp, cwd, roots, platform);
      const result = ruled(ruleCallOf(toolName, inp, callCtx()), h, () => (pv ? pv.rule : readOnly && !pathWords(inp).some((w) => !sshPublicKey(w, env)) && pathWords(inp).length > 0 ? PUBKEY_READ_RULE : null));
      if (result) return decided(result);
      return { result: undefined, danger: dangerMatch({ tool: toolName, input: inp }, { roots, platform, cwd, facts }) };
    }
    // own tools carry free text (ledger notes, plans) that may quote a floor pattern: only their prose fields skip the floors
    const proseExempt = PROSE_FIELD_TOOLS.has(toolName) || NOTE_TOOLS.has(toolName) || (deps.noteTools?.includes(toolName) ?? false);
    const ph = OWN_TOOLS.has(toolName) ? fieldFloors(inp, "", env, true) : payloadFloors(toolName, inp, env, proseExempt);
    if (ph && ph.kind === "deny") return decided(blocked(ph, toolName));
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

/** The path words of a path-tool input: the keys `pathFloors` reads for a path (PATH_KEYS). */
const pathWords = (inp: Record<string, unknown>): string[] => PATH_KEYS.map((k) => inp[k]).filter((v): v is string => typeof v === "string");

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

/** The linked worktrees of the repo (`git worktree list --porcelain` without its first block, the main checkout): path and checked-out branch (null when detached). */
export function linkedWorktrees(cwd: string): { path: string; branch: string | null }[] {
  const blocks = (gitOut(cwd, ["worktree", "list", "--porcelain"]) ?? "").split(/\n\s*\n/).slice(1);
  return blocks.flatMap((b) => {
    const p = /^worktree (.+)$/m.exec(b);
    if (!p) return [];
    const m = /^branch refs\/heads\/(.+)$/m.exec(b);
    return [{ path: p[1], branch: m ? m[1] : null }];
  });
}

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
    // every linked worktree (made by `git worktree add`); index.ts narrows it to the session's own
    return linkedWorktrees(cwd).flatMap((w) => (w.branch !== null ? [w.branch] : []));
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
