// Permission overlay (design section 5, layer 1b). Runs in `tool_call` BEFORE everything else,
// independent of @gotgenes/pi-permission-system (PS).
//
// Why it exists: PS merges its project file over the global one and that merge can loosen
// (a project `bash: "allow"` replaces the whole global deny map), and PS has no session scope.
// So the adapter enforces, by itself:
//   (a) the full merged DENY set: the packaged baseline + safety.permissions.deny/paths.deny of
//       L1 -> L3 -> L2 + whatever the project and session layers added. Deny beats any allow.
//   (b) the ASK entries the project/session layers added on top of L1 -> L3 -> L2 (the rest of
//       the asks live in the generated PS file and PS prompts for them). Confirm in TUI/RPC;
//       print mode and children are denied ("ask the foreman").
//
// Matcher differences from PS (tree-sitter bash parser + wildcard matcher), by design:
//  1. Wildcards are PS's: `*` = any characters including `/` (so `**` == `*`), `?` = one
//     character, a trailing ` *` also matches the bare command. Bash patterns are case-sensitive
//     (case-insensitive for the powershell tool); path patterns are case-insensitive and
//     separator-agnostic on win32 only.
//  2. Parsing: PS uses a real bash grammar. This is a small hand-written lexer (quotes, `\`
//     escapes, `; && || | & newline ( ) ` and `<`/`>`, `$(...)` and backticks anywhere, `# `
//     comments, `sh|bash|zsh|... -c`, `eval`, `pwsh -c`, `find -exec`, wrapper commands like
//     sudo/env/nohup/xargs up to depth 4). PS floors the same constructs to `ask`; here a deny
//     rule is looked up inside them instead. Heredoc bodies are lexed as ordinary text (more
//     words are checked, never fewer).
//  3. Paths in shell commands: EVERY word of every command (options' `=value` parts, redirect
//     targets, quoted words) is resolved (`~`, `$HOME`, cwd, `..`, symlinks, a trailing glob in
//     the last segment) and checked against the deny paths, so `cat .env`, `head ~/.ssh/id_x`,
//     `grep -r t .env`, `grep -r x ~/.ssh`, `git diff --no-index a .env` all deny. PS gates only
//     tokens it classifies as path candidates and, for a bare name, only when the file exists;
//     here a path-shaped word (contains `/` or `\`, or starts with `.` or `~`) is checked whether or not the file
//     exists (so `touch .env` and `echo x > .env` deny), and a bare word only when it exists.
//     A directory that holds denied files is denied by its own name when a pattern matches
//     `<dir>/` (`~/.ssh`, `~/.aws`), but not when it is an ANCESTOR (`grep -r x ~`): like PS,
//     the overlay does not know what a recursive command will walk into.
//  4. Not modelled (both PS and the overlay): other shell variables, command output used as a
//     path, ANSI-C `$'\x2e'` quoting, globs in a directory segment, `cd` tracking (the overlay
//     checks words against the session cwd and as typed).
//  5. Exceptions: the baseline lists `*.env.example` etc. as exceptions; they apply as in the
//     generated PS file (last matching rule wins, exceptions sit after the baseline denies and
//     before the user's own denies).
//  6. The overlay ignores PS's per-agent frontmatter and `yoloMode`: deny is deny.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Json } from "./config.ts";

export interface PathRule {
  pattern: string;
  action: "deny" | "allow";
}

export interface OverlayRules {
  bashDeny: string[];
  bashAsk: string[];
  pathRules: PathRule[];
  pathAsk: string[];
}

export interface Baseline {
  bash: { deny: string[]; ask: string[] };
  paths: { deny: string[]; except: string[] };
}

export type Decision = { kind: "deny" | "ask"; reason: string };

export interface MatchCtx {
  cwd: string;
  home: string;
  platform: string;
  /** Shell grammar of the tool: bash-like or PowerShell. */
  shell?: "posix" | "powershell";
  exists?: (p: string) => boolean;
  isDir?: (p: string) => boolean;
  realpath?: (p: string) => string | null;
  list?: (dir: string) => string[];
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

export function readBaseline(pkgRoot: string): Baseline | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(pkgRoot, "config", "permissions.baseline.json"), "utf8")) as Json;
    const bash = obj(raw.bash);
    const paths = obj(raw.paths);
    return { bash: { deny: strs(bash.deny), ask: strs(bash.ask) }, paths: { deny: strs(paths.deny), except: strs(paths.except) } };
  } catch {
    return null;
  }
}

function without(list: string[], base: string[]): string[] {
  return list.filter((x) => !base.includes(x));
}

/**
 * Rules from the baseline plus the merged `safety.permissions`. `base` is the same block before
 * the project and session layers (the config CLI's `basePermissions`); asks present there are
 * PS's job, only the added ones are enforced here. Without `base` no ask is enforced.
 */
export function buildOverlayRules(baseline: Baseline, merged: unknown, base: unknown, agentDir: string): OverlayRules {
  const m = obj(merged);
  const b = obj(base);
  const sub = (p: string): string => p.replace(/\{agentDir\}/g, agentDir.split(path.sep).join("/"));
  const mp = obj(m.paths);
  const bp = obj(b.paths);
  const hasBase = Object.keys(b).length > 0;
  return {
    bashDeny: [...baseline.bash.deny, ...strs(m.deny)],
    bashAsk: hasBase ? without(strs(m.ask), strs(b.ask)) : [],
    pathRules: [
      ...baseline.paths.deny.map((pattern): PathRule => ({ pattern: sub(pattern), action: "deny" })),
      ...baseline.paths.except.map((pattern): PathRule => ({ pattern: sub(pattern), action: "allow" })),
      ...strs(mp.deny).map((pattern): PathRule => ({ pattern: sub(pattern), action: "deny" })),
    ],
    pathAsk: hasBase ? without(strs(mp.ask), strs(bp.ask)) : [],
  };
}

// ------------------------------------------------------------------ wildcard

const reCache = new Map<string, RegExp>();

function expandHomePattern(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return home + p.slice(1);
  if (p.startsWith("$HOME")) return home + p.slice(5);
  if (p.startsWith("${HOME}")) return home + p.slice(7);
  return p;
}

/** PS's compileWildcardPattern: split on `*`, `?` = one char, trailing " *" makes the args optional. */
export function wildcardRegExp(pattern: string, opts: { home: string; ignoreCase: boolean; foldSeparators: boolean }): RegExp {
  const key = `${opts.ignoreCase ? "i" : "s"}${opts.foldSeparators ? "f" : "-"}${opts.home}\u0000${pattern}`;
  const hit = reCache.get(key);
  if (hit) return hit;
  let expanded = expandHomePattern(pattern, opts.home);
  if (opts.foldSeparators) expanded = expanded.replace(/\\/g, "/");
  let escaped = expanded
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\?/g, "."))
    .join(".*");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  const re = new RegExp(`^${escaped}$`, opts.ignoreCase ? "si" : "s");
  reCache.set(key, re);
  return re;
}

function bashMatches(pattern: string, text: string, ctx: MatchCtx): boolean {
  return wildcardRegExp(pattern, { home: ctx.home, ignoreCase: ctx.shell === "powershell", foldSeparators: false }).test(text);
}

function pathMatches(pattern: string, value: string, ctx: MatchCtx): boolean {
  const win = ctx.platform === "win32";
  return wildcardRegExp(pattern, { home: ctx.home, ignoreCase: win, foldSeparators: win }).test(win ? value.replace(/\\/g, "/") : value);
}

// --------------------------------------------------------------------- lexer

interface Parsed {
  pipelines: string[][][];
  subs: string[];
}

function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) return src.length;
      i = j;
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return src.length;
}

/** Inner text of `$( )` and backtick substitutions, also inside double quotes (never inside single quotes). */
function substitutions(src: string, shell: "posix" | "powershell"): string[] {
  const out: string[] = [];
  let inDq = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && shell === "posix") i++;
    else if (c === "`" && shell === "powershell") i++;
    else if (c === '"') inDq = !inDq;
    else if (c === "'" && !inDq) {
      const j = src.indexOf("'", i + 1);
      if (j < 0) break;
      i = j;
    } else if (c === "$" && src[i + 1] === "(") {
      const end = matchParen(src, i + 1);
      out.push(src.slice(i + 2, end));
    } else if (c === "`" && shell === "posix") {
      const j = src.indexOf("`", i + 1);
      const end = j < 0 ? src.length : j;
      out.push(src.slice(i + 1, end));
      i = end;
    }
  }
  return out;
}

/** pipelines -> units -> words (quotes removed). */
export function parseShell(src: string, shell: "posix" | "powershell" = "posix"): Parsed {
  const pipelines: string[][][] = [];
  let units: string[][] = [];
  let words: string[] = [];
  let cur: string | null = null;
  const flush = (): void => {
    if (cur !== null) words.push(cur);
    cur = null;
  };
  const endUnit = (): void => {
    flush();
    if (words.length) units.push(words);
    words = [];
  };
  const endPipe = (): void => {
    endUnit();
    if (units.length) pipelines.push(units);
    units = [];
  };
  const add = (s: string): void => {
    cur = (cur ?? "") + s;
  };
  const posix = shell === "posix";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === (posix ? "\\" : "`")) {
      if (src[i + 1] === "\n") i++;
      else if (i + 1 < src.length) add(src[++i]);
    } else if (!posix && c === "\\") add(c);
    else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? src.length : j;
      add(src.slice(i + 1, end));
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === (posix ? "\\" : "`") && j + 1 < src.length && (posix ? '"\\$`\n'.includes(src[j + 1]) : true)) j++;
        s += src[j++];
      }
      add(s);
      i = j;
      cur = cur ?? "";
    } else if (c === " " || c === "\t" || c === "\r") flush();
    else if (c === "\n" || c === ";") endPipe();
    else if (c === "&") {
      if (src[i + 1] === "&") i++;
      endPipe();
    } else if (c === "|") {
      if (src[i + 1] === "|") {
        i++;
        endPipe();
      } else {
        if (src[i + 1] === "&") i++;
        endUnit();
      }
    } else if (c === "(" || c === ")" || (posix && c === "`") || (!posix && (c === "{" || c === "}"))) endPipe();
    else if (c === "<" || c === ">") {
      if (cur !== null && /^\d+$/.test(cur)) cur = null; // 2>file: the fd number is not a word
      flush();
      while (src[i + 1] === c) i++;
      if (c === ">" && src[i + 1] === "&") i++;
    } else if (c === "#" && cur === null && (i === 0 || /\s|[;&|()]/.test(src[i - 1]))) {
      while (i < src.length && src[i] !== "\n") i++;
      i--;
    } else add(c);
  }
  endPipe();
  return { pipelines, subs: substitutions(src, shell) };
}

// -------------------------------------------------------------- command units

const WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "exec", "nohup", "time", "nice", "ionice", "timeout", "stdbuf", "setsid", "xargs", "watch", "chroot"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"]);

function baseName(w: string): string {
  const b = w.split(/[\\/]/).pop() ?? w;
  return b.toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
}

/** The unit as written, then with env assignments / wrapper commands / the path prefix stripped. */
function variants(words: string[]): { texts: string[]; core: string[] } {
  let w = words.slice();
  const texts: string[] = [];
  for (let n = 0; n < 8 && w.length; n++) {
    texts.push(w.join(" "));
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) {
      w = w.slice(1);
      continue;
    }
    const base = baseName(w[0]);
    if (base !== w[0]) {
      w = [base, ...w.slice(1)];
      texts.push(w.join(" "));
    }
    if (!WRAPPERS.has(base)) break;
    w = w.slice(1);
    while (w.length && (w[0].startsWith("-") || /^\d+(\.\d+)?[smhd]?$/.test(w[0]))) w = w.slice(1);
  }
  return { texts, core: w };
}

/** The script a shell-ish unit carries in an argument (`bash -c '...'`, `eval ...`, `pwsh -c ...`). */
function innerScript(core: string[]): { script: string; shell: "posix" | "powershell" } | null {
  if (!core.length) return null;
  const cmd = baseName(core[0]);
  if (SHELLS.has(cmd)) {
    const i = core.findIndex((x, k) => k > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(x));
    return i > 0 && core[i + 1] !== undefined ? { script: core[i + 1], shell: "posix" } : null;
  }
  if (cmd === "eval") return core.length > 1 ? { script: core.slice(1).join(" "), shell: "posix" } : null;
  if (cmd === "pwsh" || cmd === "powershell") {
    const i = core.findIndex((x, k) => k > 0 && /^-(c|command)$/i.test(x));
    return i > 0 && core[i + 1] !== undefined ? { script: core.slice(i + 1).join(" "), shell: "powershell" } : null;
  }
  if (cmd === "cmd") {
    const i = core.findIndex((x, k) => k > 0 && /^\/[ck]$/i.test(x));
    return i > 0 ? { script: core.slice(i + 1).join(" "), shell: "powershell" } : null;
  }
  return null;
}

interface Collected {
  unitTexts: string[];
  pipeTexts: string[];
  words: string[];
}

const MAX_DEPTH = 4;

function collect(src: string, shell: "posix" | "powershell", depth: number, out: Collected): void {
  const parsed = parseShell(src, shell);
  for (const inner of parsed.subs) if (depth < MAX_DEPTH) collect(inner, shell, depth + 1, out);
  const visit = (unitWords: string[]): void => {
    out.words.push(...unitWords);
    const v = variants(unitWords);
    out.unitTexts.push(...v.texts);
    const inner = innerScript(v.core);
    if (inner && depth < MAX_DEPTH) collect(inner.script, inner.shell, depth + 1, out);
    const exec = v.core.findIndex((x) => x === "-exec" || x === "-execdir" || x === "-ok" || x === "-okdir");
    if (exec >= 0 && depth < MAX_DEPTH) {
      const rest = v.core.slice(exec + 1);
      const end = rest.findIndex((x) => x === ";" || x === "+");
      visit(end >= 0 ? rest.slice(0, end) : rest);
    }
  };
  for (const pipe of parsed.pipelines) {
    out.pipeTexts.push(pipe.map((u) => u.join(" ")).join(" | "));
    for (const u of pipe) visit(u);
  }
}

// ---------------------------------------------------------------------- paths

const GLOB = /[*?[]/;

function defaults(ctx: MatchCtx): Required<Pick<MatchCtx, "exists" | "isDir" | "realpath" | "list">> {
  return {
    exists: ctx.exists ?? ((p) => fs.existsSync(p)),
    isDir: ctx.isDir ?? ((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }),
    realpath: ctx.realpath ?? ((p) => { try { return fs.realpathSync(p); } catch { return null; } }),
    list: ctx.list ?? ((d) => { try { return fs.readdirSync(d).slice(0, 500); } catch { return []; } }),
  };
}

function expandWord(w: string, ctx: MatchCtx): string {
  let s = w.replace(/^file:\/\//, "");
  if (s === "~") s = ctx.home;
  else if (s.startsWith("~/") || s.startsWith("~\\")) s = ctx.home + s.slice(1);
  s = s.replace(/^\$\{?HOME\}?(?=$|[\\/])/, ctx.home);
  return s.replace(/^\$env:(USERPROFILE|HOME)(?=$|[\\/])/i, ctx.home);
}

function globRegExp(segment: string): RegExp {
  const body = segment.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "s");
}

/**
 * Every concrete spelling of one word that a path rule should see. A word with white space is
 * prose or a script (`-m "see .env"`, `python -c "open('.env')"`): its parts are checked.
 */
function pathCandidates(word: string, ctx: MatchCtx): string[] {
  const parts = /\s/.test(word) ? word.split(/[\s'"`(),;<>]+/).filter(Boolean) : [word];
  return parts.flatMap((x) => tokenCandidates(x, ctx, 0));
}

function tokenCandidates(word: string, ctx: MatchCtx, depth: number): string[] {
  const fsx = defaults(ctx);
  const p = ctx.platform === "win32" ? path.win32 : path.posix;
  const s = expandWord(word, ctx);
  const out: string[] = [];
  const eq = s.indexOf("=");
  if (eq > 0 && depth === 0) out.push(...tokenCandidates(s.slice(eq + 1), ctx, 1));
  if (!s) return out;
  const abs = p.resolve(ctx.cwd, s);
  const pathShaped = /^[.~]|[\\/]/.test(s);
  if (!pathShaped && !fsx.exists(abs)) return out;
  const add = (x: string): void => {
    out.push(x);
    if (x.endsWith("/") || x.endsWith("\\")) return;
    if (fsx.isDir(x)) out.push(x + p.sep);
  };
  if (s !== abs) out.push(s);
  add(abs);
  const real = fsx.realpath(abs);
  if (real && real !== abs) add(real);
  if (GLOB.test(s)) {
    const dir = p.dirname(abs);
    const re = globRegExp(p.basename(abs));
    if (!GLOB.test(dir)) for (const name of fsx.list(dir)) if (re.test(name) && (name.startsWith(".") || !p.basename(abs).startsWith("."))) add(p.join(dir, name));
  }
  return out;
}

function pathDeny(rules: PathRule[], word: string, ctx: MatchCtx): PathRule | null {
  for (const cand of pathCandidates(word, ctx)) {
    let verdict: PathRule | null = null;
    for (const r of rules) if (pathMatches(r.pattern, cand, ctx)) verdict = r;
    if (verdict && verdict.action === "deny") return verdict;
  }
  return null;
}

function pathAskHit(patterns: string[], word: string, ctx: MatchCtx): string | null {
  for (const cand of pathCandidates(word, ctx)) for (const pat of patterns) if (pathMatches(pat, cand, ctx)) return pat;
  return null;
}

// ------------------------------------------------------------------- decisions

const clip = (s: string): string => (s.length > 120 ? `${s.slice(0, 117)}...` : s);

export function checkShell(rules: OverlayRules, command: string, ctx: MatchCtx): Decision | null {
  const shell = ctx.shell ?? "posix";
  const c: Collected = { unitTexts: [], pipeTexts: [command.trim(), command.trim().replace(/\s+/g, " ")], words: [] };
  collect(command, shell, 0, c);
  const texts = [...c.unitTexts, ...c.pipeTexts];
  for (const pat of rules.bashDeny) {
    if (texts.some((t) => bashMatches(pat, t, ctx))) return { kind: "deny", reason: `pi-foreman: denied by the permission policy (command rule '${pat}'). This cannot be approved; use another way.` };
  }
  for (const w of c.words) {
    const hit = pathDeny(rules.pathRules, w, ctx);
    if (hit) return { kind: "deny", reason: `pi-foreman: denied by the permission policy (path rule '${hit.pattern}' matched '${clip(w)}'). Secret and policy paths are off limits to the agent, also through shell commands.` };
  }
  for (const pat of rules.bashAsk) {
    if (texts.some((t) => bashMatches(pat, t, ctx))) return { kind: "ask", reason: `pi-foreman: this command needs approval (project/session rule '${pat}').` };
  }
  for (const w of c.words) {
    const pat = pathAskHit(rules.pathAsk, w, ctx);
    if (pat) return { kind: "ask", reason: `pi-foreman: this path needs approval (project/session rule '${pat}' matched '${clip(w)}').` };
  }
  return null;
}

const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

export function isOverlayTool(toolName: string): boolean {
  return toolName === "bash" || toolName === "powershell" || PATH_TOOLS.has(toolName);
}

export function checkPathTool(rules: OverlayRules, toolName: string, input: Record<string, unknown>, ctx: MatchCtx): Decision | null {
  if (!PATH_TOOLS.has(toolName)) return null;
  const raw = [input.path, input.file_path, input.filePath].find((x) => typeof x === "string" && x.length > 0) as string | undefined;
  if (raw === undefined) return null;
  const hit = pathDeny(rules.pathRules, raw, ctx);
  if (hit) return { kind: "deny", reason: `pi-foreman: denied by the permission policy (path rule '${hit.pattern}' matched '${clip(raw)}' for ${toolName}).` };
  const pat = pathAskHit(rules.pathAsk, raw, ctx);
  return pat ? { kind: "ask", reason: `pi-foreman: this path needs approval (project/session rule '${pat}' matched '${clip(raw)}').` } : null;
}

export function checkToolCall(rules: OverlayRules, toolName: string, input: Record<string, unknown>, ctx: MatchCtx): Decision | null {
  if (toolName === "bash" || toolName === "powershell") {
    const command = typeof input.command === "string" ? input.command : "";
    return command ? checkShell(rules, command, { ...ctx, shell: toolName === "powershell" ? "powershell" : "posix" }) : null;
  }
  return checkPathTool(rules, toolName, input, ctx);
}

export interface AskEnv {
  isChild: boolean;
  mode: string;
  hasUI: boolean;
  confirm?: (title: string, message: string) => Promise<boolean>;
}

/** deny -> block; ask -> confirm in TUI/RPC, block in print/json mode and in children. */
export async function resolveDecision(d: Decision | null, ask: AskEnv): Promise<{ block: true; reason: string } | undefined> {
  if (!d) return undefined;
  if (d.kind === "deny") return { block: true, reason: d.reason };
  if (ask.isChild) return { block: true, reason: `${d.reason} Needs approval: ask the foreman (project/session asks are not forwarded from children).` };
  if ((ask.mode === "tui" || ask.mode === "rpc") && ask.hasUI && ask.confirm) {
    let ok = false;
    try {
      ok = await ask.confirm("pi-foreman: approval needed", d.reason);
    } catch {
      ok = false;
    }
    return ok ? undefined : { block: true, reason: `Denied by the user. ${d.reason}` };
  }
  return { block: true, reason: `${d.reason} Needs approval, no UI (mode: ${ask.mode}).` };
}

/** Message for a session that could not load the baseline: shell and file tools are blocked. */
export const OVERLAY_UNAVAILABLE = "pi-foreman: the permission baseline (config/permissions.baseline.json) could not be read, so shell and file tools are blocked. Reinstall pi-foreman and run /foreman doctor.";
