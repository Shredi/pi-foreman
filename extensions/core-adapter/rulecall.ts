// The view the gate and its path and protected checks take of a tool call: the tool families, the resolved paths of a path call, the normalised
// segments of a shell line, and the path glob of a protected entry (`~/x` home, `//x` the absolute path `/x`, `/x` and `x` relative to the main
// checkout, `**` any depth, `*` within one segment, `?` one character; slash and case rules are pathnorm.ts's).
import * as path from "node:path";
import type { ShellSegment } from "./shellast.ts";
import { comparableFs, nullDevice, slashForm } from "./pathnorm.ts";
import { PATH_TOOL_NAMES } from "./pathrules.ts";
import { OWN_TOOLS } from "./defaults.ts";

export const BASH_TOOLS: ReadonlySet<string> = new Set(["bash", "bg_run", "powershell"]);
export const READ_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);
/** `gate.readTools`: extension tool name -> its path field (null: no path field, the tool reads the cwd). */
export type ReadToolMap = Readonly<Record<string, string | null>>;

/** Built-in tools: the path tools (read/write/edit/grep/find/ls, foreman_move, foreman_copy), the shell tools and pi-foreman's own tools. `gate.readTools` never remaps them. */
export function isBuiltinTool(tool: string): boolean {
  return PATH_TOOL_NAMES.has(tool) || READ_TOOLS.has(tool) || BASH_TOOLS.has(tool) || OWN_TOOLS.has(tool);
}

/** The path field of a configured read tool (null: none), or undefined when `tool` is not one; the built-in tools are never remapped. */
export function readFieldOf(map: ReadToolMap | undefined, tool: string): string | null | undefined {
  if (!map || !Object.hasOwn(map, tool) || isBuiltinTool(tool)) return undefined;
  const f = map[tool];
  return typeof f === "string" || f === null ? f : undefined;
}

const EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "foreman_move", "foreman_copy"]);

const esc = (c: string): string => c.replace(/[.+^${}()|[\]\\]/g, "\\$&");

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

export interface RuleEnv {
  cwd: string;
  home: string;
  platform: string;
  /** The main checkout: the base of relative path patterns (a worktree's own files are not what the owner means). */
  checkout: string;
  /** `gate.readTools`: a `Read(...)` rule also covers these tools. */
  readTools?: ReadToolMap;
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
  return comparableFs(env.platform, p);
}

/** Whether the path glob (the syntax of `Read(...)` / `Edit(...)` patterns) matches the absolute path `abs`. */
export function pathGlobMatch(pattern: string, abs: string, env: RuleEnv): boolean {
  return pathRegex(pathPattern(pattern, env)).test(comparableFs(env.platform, abs));
}

// ------------------------------------------------------------------ the call

export interface RuleSegment {
  /** The normalised text (normaliseSegment). */
  text: string;
  opaque: boolean;
  /** The segment redirects output somewhere other than the null device (/dev/null; NUL on win32). */
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
  /** `gate.readTools`: extension tools judged like read/grep. */
  readTools?: ReadToolMap;
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
        ? segs.map((s) => ({ text: normaliseSegment(s, ctx.platform), opaque: s.opaque !== null, writesRedirect: s.redirects.some((r) => r.op !== "<" && r.op !== "dup" && !nullDevice(ctx.platform, r.target)) }))
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
  const rf = readFieldOf(ctx.readTools, tool);
  if (rf !== undefined) {
    const p = resolve((rf === null ? undefined : inp[rf]) ?? ".");
    return { tool, paths: p ? [p] : [] };
  }
  if (EDIT_TOOLS.has(tool)) {
    const ws = tool === "foreman_move" ? [inp.src, inp.dst] : tool === "foreman_copy" ? [inp.dst] : [inp.path ?? inp.file_path ?? inp.filePath];
    return { tool, paths: ws.map(resolve).filter((p): p is string => p !== undefined) };
  }
  if (tool === "fetch") return { tool, url: strOf(inp.url) ?? "", payload: JSON.stringify(inp) };
  return { tool, payload: JSON.stringify(inp) };
}

/**
 * The built-in allow of a call: `builtin(i, opaque)` names the allow of unit `i` (a segment of the line, a path of the call, 0 for a single-unit call)
 * or returns null; an opaque unit is asked with `opaque` true. Allowed only when every unit is covered; the allow rule names are joined with `+`.
 */
export function builtinAllow(call: RuleCall, builtin: (unit: number, opaque?: boolean) => string | null): string | null {
  const units = call.segments ? call.segments.map((s) => s.opaque) : call.paths ? call.paths.map(() => false) : [false];
  if (units.length === 0) return null;
  const names: string[] = [];
  for (let i = 0; i < units.length; i++) {
    const name = builtin(i, units[i] ? true : undefined);
    if (name === null) return null;
    if (!names.includes(name)) names.push(name);
  }
  return names.join("+");
}
