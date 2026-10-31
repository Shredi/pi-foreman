// r79 pattern rules: the Claude-Code-style syntax of permissions.json `allow` / `ask` / `deny`, and the per-segment evaluation of a call against them.
//
// Syntax: `Tool` (every call of the tool) or `Tool(pattern)`.
//   Bash(<glob>)        shell tools (bash, foreman_bg, bg_run, powershell); the glob meets the normalised text of EACH segment of the line
//                       (`program arg arg`, single spaces, quotes stripped). `*` is any run of characters, `?` one; the whole text must match.
//                       A trailing ` *` (or the old `:*`) also matches the bare prefix: `Bash(git status *)` matches `git status`. A segment that
//                       redirects output (except to /dev/null) is matched by an allow rule only when the pattern names the redirect (`>`).
//   Read(<path glob>)   read, grep, find, ls.  Edit(...) edit, write, foreman_move, foreman_copy.  Write(...) write, foreman_move, foreman_copy.
//                       The glob meets the resolved absolute path: `~/x` home, `//x` the absolute path `/x` (`//c:/x` on win32), `/x` and `x`
//                       relative to the MAIN checkout (not the worktree), `**` any depth, `*` within one segment, `?` one character. Slash and case
//                       rules are pathnorm.ts's (win32 folds case, backslashes equal slashes). Lexical: a symlink is not followed.
//   fetch(<glob>)       the URL of a fetch call.
//   mcp__server__tool, mcp__server__*, mcp__server    MCP tools; the optional glob meets the JSON payload.
//   <Name>(<glob>)      any other tool by exact name; the glob meets the JSON payload.
// Evaluation (matchRules): any unit (segment / path) matching a deny rule denies; else any matching an ask rule asks; else the call is allowed
// when EVERY unit is non-opaque and matches an allow rule or a built-in allow (the caller's callback); else `none`.
import * as path from "node:path";
import type { ShellSegment } from "./shellast.ts";
import { comparable, foldCase, slashForm } from "./pathnorm.ts";

export type RuleFamily = "bash" | "read" | "edit" | "write" | "named";

export interface ParsedRule {
  /** The rule as written (trimmed). */
  text: string;
  tool: string;
  family: RuleFamily;
  /** The glob between the parentheses, or null for a bare tool rule. */
  pattern: string | null;
}

export type ParseResult = { ok: true; rule: ParsedRule } | { ok: false; error: string };

export const BASH_TOOLS: ReadonlySet<string> = new Set(["bash", "foreman_bg", "bg_run", "powershell"]);
export const READ_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);
const EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "foreman_move", "foreman_copy"]);
const WRITE_TOOLS: ReadonlySet<string> = new Set(["write", "foreman_move", "foreman_copy"]);
/** Lower-case spellings of tools that have a family name: a rule using them would silently match the JSON payload, so they are refused. */
const FAMILY_ALIASES: ReadonlySet<string> = new Set([...BASH_TOOLS, ...READ_TOOLS, ...EDIT_TOOLS]);

const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*\*?$/;

/** Parse one rule text. A bad rule is an error with a reason, never a silent no-match. */
export function parseRule(input: string): ParseResult {
  if (typeof input !== "string") return { ok: false, error: "a rule is a string" };
  const text = input.trim();
  const m = /^([^()]*?)(?:\(([\s\S]*)\))?$/.exec(text);
  if (!m) return { ok: false, error: `unbalanced parentheses in '${clip(text)}'` };
  const tool = m[1].trim();
  const pattern = m[2] === undefined ? null : m[2];
  if (!tool) return { ok: false, error: `no tool name in '${clip(text)}'` };
  if (pattern !== null && pattern.trim() === "") return { ok: false, error: `empty pattern in '${clip(text)}' (write the bare tool name to match every call)` };
  if (/\*/.test(tool) ? !(tool.startsWith("mcp__") && TOOL_NAME.test(tool) && tool.indexOf("*") === tool.length - 1) : !TOOL_NAME.test(tool)) return { ok: false, error: `'${clip(tool)}' is not a tool name (a '*' is allowed only at the end of an mcp__ name)` };
  if (FAMILY_ALIASES.has(tool)) return { ok: false, error: `'${tool}' is a built-in tool: use Bash, Read, Edit or Write` };
  const family: RuleFamily = tool === "Bash" ? "bash" : tool === "Read" ? "read" : tool === "Edit" ? "edit" : tool === "Write" ? "write" : "named";
  return { ok: true, rule: { text, tool, family, pattern } };
}

const clip = (s: string, n = 80): string => (s.length > n ? `${s.slice(0, n)}...` : s);

// ------------------------------------------------------------------ globs

const esc = (c: string): string => c.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/** A flat glob: `*` any run, `?` one character, whole string, line breaks included. */
function flatRegex(pattern: string): RegExp {
  let body = "";
  for (const c of pattern) body += c === "*" ? ".*" : c === "?" ? "." : esc(c);
  return new RegExp(`^${body}$`, "s");
}

/** A path glob over a comparable (slash, folded) absolute path: `**` crosses `/`, `*` and `?` do not. */
function pathRegex(pattern: string): RegExp {
  let body = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        body += "(?:.*/)?";
        i += 2;
      } else {
        body += ".*";
        i += 1;
      }
    } else body += c === "*" ? "[^/]*" : c === "?" ? "[^/]" : esc(c);
  }
  return new RegExp(`^${body}$`, "s");
}

/** The bash glob with its optional tail: `X *` and `X:*` also match `X` alone. */
function bashMatch(pattern: string, text: string): boolean {
  const p = pattern.endsWith(":*") ? `${pattern.slice(0, -2)} *` : pattern;
  if (p.endsWith(" *") && !p.slice(0, -2).includes("*")) {
    const head = p.slice(0, -2);
    return text === head || (text.startsWith(`${head} `) && true) || flatRegex(p).test(text);
  }
  if (p.endsWith(" *")) return flatRegex(p).test(text) || flatRegex(p.slice(0, -2)).test(text);
  return flatRegex(p).test(text);
}

export interface RuleEnv {
  cwd: string;
  home: string;
  platform: string;
  /** The main checkout: the base of relative path patterns (a worktree's own files are not what the owner means). */
  checkout: string;
}

/** The absolute comparable glob of a path pattern (before the regex). */
function pathPattern(pattern: string, env: RuleEnv): string {
  const win = env.platform === "win32";
  let p = win ? pattern.replace(/\\/g, "/") : pattern;
  if (p.startsWith("//")) p = win && /^\/\/[A-Za-z]:/.test(p) ? p.slice(2) : p.slice(1);
  else if (p === "~" || p.startsWith("~/")) p = `${slashForm(env.platform, env.home)}${p.slice(1)}`;
  else if (win && /^[A-Za-z]:\//.test(p)) p = p;
  else if (p.startsWith("/")) p = `${slashForm(env.platform, env.checkout)}${p}`;
  else p = `${slashForm(env.platform, env.checkout)}/${p.replace(/^\.\//, "")}`;
  return foldCase(env.platform, slashForm(env.platform, p));
}

// ------------------------------------------------------------------ the call

export interface RuleSegment {
  /** The normalised text (normaliseSegment). */
  text: string;
  opaque: boolean;
  /** The segment redirects output somewhere other than /dev/null. */
  writesRedirect: boolean;
}

/** What the rules see of a tool call. */
export interface RuleCall {
  tool: string;
  segments?: RuleSegment[];
  /** Resolved absolute paths of a path tool call. */
  paths?: string[];
  url?: string;
  /** JSON of the input, for MCP and other named tools. */
  payload?: string;
}

/** `program arg arg` of one segment: single spaces, quotes already stripped by the parser; on win32 the program loses `.exe` and its case. */
export function normaliseSegment(seg: ShellSegment, platform: string = process.platform): string {
  const prog = platform === "win32" ? seg.program.toLowerCase().replace(/\.exe$/, "") : seg.program;
  return [prog, ...seg.argv].filter((w, i) => i > 0 || w !== "").join(" ");
}

export interface CallCtx {
  cwd: string;
  home: string;
  platform: string;
  /** The parsed segments of a shell tool's line. */
  segments?: ShellSegment[];
}

const strOf = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Build the rule view of a call. */
export function ruleCallOf(tool: string, input: unknown, ctx: CallCtx): RuleCall {
  const inp = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  if (BASH_TOOLS.has(tool)) {
    const cmd = strOf(inp.command) ?? strOf(inp.cmd) ?? "";
    const segs = ctx.segments ?? [];
    return {
      tool,
      segments: segs.length
        ? segs.map((s) => ({ text: normaliseSegment(s, ctx.platform), opaque: s.opaque !== null, writesRedirect: s.redirects.some((r) => r.op !== "<" && r.op !== "dup" && r.target !== "/dev/null") }))
        : [{ text: cmd, opaque: true, writesRedirect: false }],
    };
  }
  const x = ctx.platform === "win32" ? path.win32 : path.posix;
  const resolve = (w: unknown): string | undefined => {
    const s = strOf(w);
    if (s === undefined) return undefined;
    const e = s === "~" || s.startsWith("~/") || s.startsWith("~\\") ? x.join(ctx.home, s.slice(1)) : s;
    return x.resolve(ctx.cwd, e);
  };
  if (READ_TOOLS.has(tool)) {
    const p = resolve(inp.path ?? inp.file_path ?? inp.filePath ?? (tool === "read" ? undefined : "."));
    return { tool, paths: p ? [p] : [] };
  }
  if (EDIT_TOOLS.has(tool)) {
    const ws = tool === "foreman_move" ? [inp.src, inp.dst] : tool === "foreman_copy" ? [inp.dst] : [inp.path ?? inp.file_path ?? inp.filePath];
    return { tool, paths: ws.map(resolve).filter((p): p is string => p !== undefined) };
  }
  if (tool === "fetch") return { tool, url: strOf(inp.url) ?? "", payload: JSON.stringify(inp) };
  return { tool, payload: JSON.stringify(inp) };
}

// ------------------------------------------------------------------ evaluation

export interface RuleSets {
  deny: ParsedRule[];
  ask: ParsedRule[];
  allow: ParsedRule[];
}

export type RuleVerdict =
  | { verdict: "deny" | "ask"; rule: string }
  /** `rule`: the allow rule texts and built-in rule names that covered the units, joined with `+`. */
  | { verdict: "allow"; rule: string }
  | { verdict: "none" };

interface Unit {
  kind: "segment" | "path" | "url" | "payload";
  text: string;
  opaque: boolean;
  writesRedirect: boolean;
}

function unitsOf(call: RuleCall, env: RuleEnv): Unit[] {
  if (call.segments) return call.segments.map((s) => ({ kind: "segment", text: s.text, opaque: s.opaque, writesRedirect: s.writesRedirect }));
  if (call.paths) return call.paths.map((p) => ({ kind: "path", text: comparable(env.platform, p), opaque: false, writesRedirect: false }));
  if (call.tool === "fetch") return [{ kind: "url", text: call.url ?? "", opaque: false, writesRedirect: false }];
  return [{ kind: "payload", text: call.payload ?? "", opaque: false, writesRedirect: false }];
}

/** Whether the rule's tool covers the call's tool. */
function toolCovers(rule: ParsedRule, tool: string): boolean {
  switch (rule.family) {
    case "bash":
      return BASH_TOOLS.has(tool);
    case "read":
      return READ_TOOLS.has(tool);
    case "edit":
      return EDIT_TOOLS.has(tool);
    case "write":
      return WRITE_TOOLS.has(tool);
    default:
      if (rule.tool.endsWith("*")) return tool.startsWith(rule.tool.slice(0, -1));
      if (rule.tool.startsWith("mcp__") && rule.tool.indexOf("__", 5) < 0) return tool === rule.tool || tool.startsWith(`${rule.tool}__`);
      return tool === rule.tool;
  }
}

function ruleMatchesUnit(rule: ParsedRule, call: RuleCall, u: Unit, env: RuleEnv, allowing: boolean): boolean {
  if (!toolCovers(rule, call.tool)) return false;
  if (u.kind === "segment" && allowing && u.writesRedirect && !(rule.pattern ?? "").includes(">")) return false;
  if (rule.pattern === null) return true;
  switch (u.kind) {
    case "segment":
      return bashMatch(rule.pattern, u.text);
    case "path":
      return pathRegex(pathPattern(rule.pattern, env)).test(u.text);
    default:
      return flatRegex(rule.pattern).test(u.text);
  }
}

/**
 * Evaluate a call. `builtin(i)` names the built-in allow of unit `i` (a segment of the line, a path of the call, 0 for a single-unit call) or
 * returns null; it is asked only for a non-opaque unit no allow rule matched.
 */
export function matchRules(sets: RuleSets, call: RuleCall, env: RuleEnv, builtin?: (unit: number) => string | null): RuleVerdict {
  const units = unitsOf(call, env);
  for (const kind of ["deny", "ask"] as const) {
    for (const r of sets[kind]) {
      if (units.length === 0 ? toolCovers(r, call.tool) && r.pattern === null : units.some((u) => ruleMatchesUnit(r, call, u, env, false))) return { verdict: kind, rule: r.text };
    }
  }
  if (units.length === 0) return { verdict: "none" };
  const names: string[] = [];
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u.opaque) return { verdict: "none" };
    const r = sets.allow.find((x) => ruleMatchesUnit(x, call, u, env, true));
    const name = r ? r.text : (builtin?.(i) ?? null);
    if (name === null) return { verdict: "none" };
    if (!names.includes(name)) names.push(name);
  }
  return { verdict: "allow", rule: names.join("+") };
}

// ------------------------------------------------------------------ proposeRule

/** Words that hand the rest of the line to another program: a rule built on a program that carries one would allow anything after it. */
const EXEC_FLAG = /^(?:-e|-c|-x|-exec|-execdir|-ok|--exec(?:=.*)?|--upload-pack(?:=.*)?|-oProxyCommand.*)$/;

/**
 * The pattern rules that would allow the segments of a line, `Bash(<program> <first non-flag arg> *)` each, or null when any segment cannot be
 * covered safely: an opaque segment, an exec flag anywhere in it (`-e`, `-c`, `-exec`, `--exec`, `-x`, `--upload-pack`, `-o ProxyCommand`), glob
 * characters in the words, or a first argument that is a flag (`git -C dir status` has no stable subcommand). Allow rules on such programs have to
 * spell the flag out by hand.
 */
export function proposeRule(segments: ShellSegment[]): string[] | null {
  if (segments.length === 0) return null;
  const out: string[] = [];
  for (const s of segments) {
    if (s.opaque !== null || s.program === "") return null;
    const words = [s.program, ...s.argv];
    if (words.some((w) => /[*?()\n]/.test(w))) return null;
    if (s.argv.some((w, i) => EXEC_FLAG.test(w) || (w === "-o" && /^ProxyCommand/i.test(s.argv[i + 1] ?? "")))) return null;
    const first = s.argv[0];
    if (first !== undefined && first.startsWith("-")) return null;
    const rule = first === undefined ? `Bash(${s.program} *)` : `Bash(${s.program} ${first} *)`;
    if (!out.includes(rule)) out.push(rule);
  }
  return out;
}

// ------------------------------------------------------------------ describeCall

/** A variable part of a sentence: control characters stripped, capped at 80, in double quotes. */
function q(v: string | undefined): string {
  const clean = (v ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/"/g, "'").replace(/\s+/g, " ").trim();
  return `"${clean.length > 80 ? `${clean.slice(0, 79)}…` : clean}"`;
}

export interface DescribeInput {
  /** The `danger-*` name (with or without the prefix). */
  name: string;
  tool: string;
  segments?: ShellSegment[];
  input?: Record<string, unknown>;
}

const flagless = (a: string[]): string[] => a.filter((w) => !w.startsWith("-"));

/** The host of a URL, `user@host:path` operand or `host` word, or undefined. */
function hostOf(w: string | undefined): string | undefined {
  if (!w) return undefined;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(w)) return new URL(w).host;
  } catch {
    return undefined;
  }
  const m = /^(?:[^@\s/]+@)?([^:/\s]+):/.exec(w);
  return m ? m[1] : /^(?:[^@\s/]+@)?([A-Za-z0-9.-]+)$/.exec(w)?.[1];
}

/**
 * One sentence for a dangerous-class call, used as the title of the remember step and as the prose entry that "allow and remember" writes
 * (a type of request, not the exact command). Variable parts are quoted and capped; nothing the call carries can end a sentence early.
 */
export function describeCall(d: DescribeInput): string {
  const name = d.name.replace(/^danger-/, "");
  const segs = (d.segments ?? []).filter((s) => s.program !== "");
  const s = segs[0];
  const argv = s ? flagless(s.argv) : [];
  const prog = s ? s.program : d.tool;
  const inp = d.input ?? {};
  switch (name) {
    case "write-outside": {
      const p = strOf(inp.path ?? inp.file_path ?? inp.filePath ?? inp.dst) ?? s?.redirects.find((r) => r.op !== "<" && r.op !== "dup")?.target ?? argv[argv.length - 1];
      return `Write files outside the worktree, for example ${q(p)}`;
    }
    case "deploy": {
      const host = segs.map((x) => flagless(x.argv).map(hostOf).find((h) => h !== undefined)).find((h) => h !== undefined);
      const ns = s ? s.argv[s.argv.findIndex((w) => w === "-n" || w === "--namespace") + 1] : undefined;
      return `Run ${q(prog)} ${q(argv[0])}${host ? ` against the host ${q(host)}` : ""}${ns && s?.argv.some((w) => w === "-n" || w === "--namespace") ? ` in the namespace ${q(ns)}` : ""}`;
    }
    case "forge":
      return `Change something on the forge with ${q([prog, ...argv.slice(0, 2)].join(" "))}`;
    case "publish":
      return `Publish a package or release with ${q([prog, ...argv.slice(0, 1)].join(" "))}`;
    case "net-write": {
      const url = strOf(inp.url) ?? s?.argv.find((w) => /^[a-z][a-z0-9+.-]*:\/\//i.test(w));
      return `Send data over the network${url ? ` to the host ${q(hostOf(url) ?? url)}` : ""} with ${q(prog)}`;
    }
    case "install":
      return `Install or remove software with ${q(prog)}${argv[1] ? `, for example the package ${q(argv[1])}` : ""}`;
    case "git": {
      const sub = s?.argv.filter((w) => !w.startsWith("-"))[0];
      const origin = s && sub === "push" ? argv[1] : undefined;
      return `Run the history-changing git command ${q(`git ${(s?.argv ?? []).slice(0, 4).join(" ")}`)}${origin && /[:/]/.test(origin) ? ` to the origin ${q(origin)}` : ""}`;
    }
    case "process":
      return `Control processes or system settings with ${q(prog)}`;
    case "inject":
      return `Type text into another terminal with ${q(prog)}`;
    case "opaque":
      return "Run a shell line the parser cannot read exactly";
    case "mcp-act":
      return `Call the MCP tool ${q(d.tool)} that acts on an outside system`;
    case "launch-outside":
      return `Launch a session in the directory ${q(strOf(inp.cwd) ?? strOf(inp.worktree) ?? "(a workflow or task list)")} outside the owned roots`;
    default:
      return `Run a ${q(name)} call with ${q(d.tool)}`;
  }
}
