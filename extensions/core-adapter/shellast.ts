/**
 * A bash command line as a list of segments (round 41, A1), on top of the `unbash` parser. One segment is one simple
 * command that would run: chains, pipelines, `$(...)`, backticks, subshells, `bash -c` / `sh -c` / `eval` with a
 * literal string and the wrappers env, timeout, nice, nohup, xargs, time, command, stdbuf, setsid, watch, flock -c are
 * unwrapped (the wrapper names land in `wrappers`). shellchain.ts refuses all of these (null); here they parse.
 *
 * Anything the walker cannot state exactly is an OPAQUE segment: `opaque` holds a reason code and the consumer treats the
 * segment as unknown (never a default allow). The refusals of shellchain.ts and effects.ts stay refusals: a construct that is
 * not modelled below falls into `unsupported`. Variables resolve only through the closed grammar of shellvars.ts
 * (`resolveVars`); every other `$NAME`, `$(...)` or glob inside a word makes the word, so the segment, opaque.
 *
 * `cwd` is the effective directory of the segment: `cd <literal>` earlier on the line (also relative to `opts.cwd`) and
 * `git -C <dir>`; null when unknown. A `cd` inside a subshell, pipeline, `||` branch, loop or `bash -c` string does not leak out.
 * `heredoc` is true for `<<`, `<<-` and `<<<`. `argv` holds literal words; the raw text of a word that is not literal.
 * A statement of only harmless assignments (`LANG=C`, or a grammar assignment such as `D=/x`) is a segment with program "".
 * No unbash type leaves this file.
 */

import { forEachChild, parse } from "unbash";
import type { Assignment, Command, CommandNode, CompoundList, ParsedScript as Script, Redirection, Statement, SyntaxNode, Word } from "unbash";
import { RUNNERS } from "./effects.ts";
import { cdTarget, childAssignValues, grammarStatements, headerOf, resolveVars } from "./shellvars.ts";
import type { ChildAssign } from "./shellvars.ts";

export type OpaqueReason =
  | "unresolved_var" // a variable outside the closed grammar, `$(...)` in a word, `~`, arithmetic
  | "glob_target" // `*` `?` `[..]`, extglob, brace expansion in a word
  | "process_substitution"
  | "nonliteral_script" // bash -c / eval / watch / flock -c whose script is not a literal string
  | "depth" // nesting deeper than MAX_DEPTH
  | "parse_error"
  | "foreign_shell" // powershell, pwsh, cmd, wsl, .ps1 / .cmd / .bat
  | "function_def"
  | "shell_builtin" // alias, unalias, shopt, trap, hash -p, enable, builtin
  | "assignment" // outside the harmless names, `export`/`declare` of one, env prefix
  | "stdin_fed" // a shell or interpreter reading its program from a heredoc, here-string, `<`, pipe or `-`
  | "xargs_stdin" // xargs: the operands come from stdin
  | "writing_wrapper" // time -o, flock <file>, nohup without redirect, tee, script
  | "wrapper_option" // an option of a wrapper this walker does not model
  | "unsupported"; // select, coproc, [[ ]], (( )) ...

export interface ShellRedirect {
  /** `dup` is an fd duplication (`2>&1`, target the fd or `-`). */
  op: ">" | ">>" | "&>" | "&>>" | "<" | "<>" | ">|" | "dup";
  fd: string | null;
  target: string;
}

export interface ShellSegment {
  program: string;
  argv: string[];
  redirects: ShellRedirect[];
  heredoc: boolean;
  /** The text of a heredoc or here-string of this command, on any descriptor; `literal` is false for a here-string word that is computed (its raw text). */
  stdinBodies?: Array<{ text: string; literal: boolean }>;
  /** The text of a `parse_error` or `depth` segment that could not be walked, or the body of a function, `coproc`, `select` or arithmetic `for`, or a whole `(( ))` command (which the walker does not enter). */
  source?: string;
  /** The text (with its `$(`, backtick or `<(` delimiters) of each command or process substitution inside a `[[ ]]` test, `(( ))` command or `select` word list, which the walker does not enter. */
  substitutions?: string[];
  /** Per `argv` word: true when the word is not literal (an expansion or a glob), so its text in `argv` is the raw word, not a value. */
  computed?: boolean[];
  /** The command follows the `time` keyword of its pipeline. */
  afterTime?: boolean;
  /** A later stage of a pipeline: stdin comes from the stage before. */
  piped?: boolean;
  /** The names assigned in this command's environment prefix and by an `env` wrapper (`GIT_CONFIG_NOSYSTEM=1 git ...`). */
  envNames?: string[];
  cwd: string | null;
  /** The wrappers this segment was unwrapped from, outermost first (`env`, `bash`, `$(`, backtick ...). */
  wrappers: string[];
  opaque: OpaqueReason | null;
}

export interface ShellParseOptions {
  /** The directory the line starts in (`$PWD` for the variable grammar). */
  cwd?: string | null;
  /** The harness env the variable grammar reads (`FOREMAN_SCRATCH`). */
  env?: Record<string, string>;
  /** Defaults to process.platform; "win32" switches on the drive-path forms of shellvars.ts. */
  platform?: string;
}

export const MAX_DEPTH = 4;

const HARMLESS = new Set(["LANG", "TZ", "NO_COLOR", "FORCE_COLOR", "CI", "DEBUG", "NODE_ENV", "PYTHONDONTWRITEBYTECODE", "GIT_PAGER", "PAGER"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash"]);
const INTERPRETERS = new Set([...SHELLS, "node", "nodejs", "bun", "deno", "python", "python2", "python3", "perl", "ruby", "php", "lua", "rscript"]);
const FOREIGN = new Set(["powershell", "pwsh", "cmd", "wsl"]);
const BUILTINS = new Set(["alias", "unalias", "shopt", "trap", "enable", "builtin"]);
const DECLARE = new Set(["export", "declare", "typeset", "local", "readonly"]);
/** Builtins whose job is to set a variable from input; the name or value is never a closed literal. */
const ASSIGNING = new Set(["read", "mapfile", "readarray", "getopts", "let"]);
/** Programs effects.ts refuses (RUNNERS) that this walker does not unwrap; the reason says why. */
const runnerReason = (name: string): OpaqueReason => (name === "exec" || name === "source" || name === "." ? "shell_builtin" : name === "fish" || name === "csh" || name === "tcsh" || name === "zsh" ? "foreign_shell" : "unsupported");
/** `declare`-family words that assign: a nameref/unexport option, or any operand that is not a harmless `NAME=literal`. */
const declares = (rest: W[]): boolean =>
  rest.some((a) => {
    const v = a.value ?? a.text;
    if (/^-[A-Za-z]*$/.test(v)) return v.includes("n");
    if (v === "--") return false;
    const x = a.assign ?? asAssign(a);
    return !(x && harmless(x));
  });
const INLINE = /^-[A-Za-z]*[cemEp]$|^--(eval|print)(=|$)/;
const FOREIGN_FILE = /\.(ps1|cmd|bat)$/i;
const RANK: Record<string, number> = { process_substitution: 0, glob_target: 1, unresolved_var: 2 };

interface Run {
  out: ShellSegment[];
  vars: Map<Command, Map<string, string | undefined>>;
  assignOk: Set<Command>;
  env: Record<string, string>;
  platform: string;
}

interface Scope {
  run: Run;
  cwd: string | null;
  wrappers: string[];
  depth: number;
  /** stdin comes from a pipe, a heredoc, a here-string or `<`. */
  stdin: boolean;
  pipe?: boolean;
  /** The command follows the `time` keyword (`time -o x ...`: the parser leaves `-o` as the program, the guard reads `time` as a wrapper with options). */
  time?: boolean;
  /** The text the node positions of the script being walked refer to. */
  src?: string;
  redirects: ShellRedirect[];
  heredoc: boolean;
  bodies: Array<{ text: string; literal: boolean }>;
  reason: OpaqueReason | null;
}

/** One simple command being resolved. */
interface Cmd {
  sc: Scope;
  redirs: ShellRedirect[];
  heredoc: boolean;
  bodies: Array<{ text: string; literal: boolean }>;
  feeds: boolean;
  envNames?: string[];
  reason: OpaqueReason | null;
}

interface Assign {
  name: string;
  append: boolean;
  value: string | null;
}

interface W {
  text: string;
  /** The literal value; null when the word is not literal. */
  value: string | null;
  reason: OpaqueReason | null;
  assign?: Assign;
}

interface Opt {
  name: string;
  value: string | null;
}

interface OptSpec {
  /** Short flags without a value, short flags with a value, long flags, long flags with a value. */
  flags?: string;
  arg?: string;
  long?: string[];
  longArg?: string[];
  /** `-5` style (nice). */
  numeric?: boolean;
}

const win32 = (rn: Run): boolean => rn.platform === "win32";
const baseName = (prog: string): string => (prog.split(/[\\/]/).pop() ?? prog).toLowerCase().replace(/\.exe$/, "");
const pick = (a: OpaqueReason | null, b: OpaqueReason | null): OpaqueReason | null => a ?? b;

function wordOf(w: Word, vars?: Map<string, string | undefined>): W {
  let out = "";
  let reason: OpaqueReason | null = null;
  const note = (r: OpaqueReason): void => {
    if (!reason || (RANK[r] ?? 9) < (RANK[reason] ?? 9)) reason = r;
  };
  const ref = (name: string): void => {
    const v = vars?.get(name);
    if (v === undefined) note("unresolved_var");
    else out += v;
  };
  const part = (p: any): void => {
    switch (p.type) {
      case "Literal":
      case "SingleQuoted":
        out += p.value;
        return;
      case "DoubleQuoted":
        for (const c of p.parts) part(c);
        return;
      case "SimpleExpansion":
        ref(String(p.text).slice(1));
        return;
      case "ParameterExpansion":
        if (!p.operation && !p.prefix && !p.index) ref(p.parameter);
        else note("unresolved_var");
        return;
      case "Glob":
      case "ExtendedGlob":
      case "BraceExpansion":
        note("glob_target");
        return;
      case "ProcessSubstitution":
        note("process_substitution");
        return;
      default:
        note("unresolved_var");
    }
  };
  if (w.text.startsWith("~")) note("unresolved_var"); // bash expands an unquoted tilde
  if (w.parts) for (const p of w.parts) part(p);
  else out = w.value;
  return { text: w.text, value: reason ? null : out, reason };
}

function asAssign(w: W): Assign | undefined {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/.exec(w.value ?? w.text);
  if (!m) return undefined;
  return { name: m[1], append: m[2] === "+", value: w.value === null ? null : w.value.slice(m[0].length) };
}

function assignW(a: Assignment, vars?: Map<string, string | undefined>): W {
  const v = a.value.type === "Word" ? wordOf(a.value, vars) : { text: a.text, value: null, reason: "assignment" as OpaqueReason };
  const eq = `${a.name}${a.append ? "+" : ""}=`;
  const w: W = { text: a.text, value: v.value === null ? null : eq + v.value, reason: v.reason };
  w.assign = { name: a.name, append: !!a.append, value: v.value };
  return w;
}

const harmless = (a: Assign): boolean => !a.append && a.value !== null && (HARMLESS.has(a.name) || a.name.startsWith("LC_"));

/** The command substitutions and process substitutions inside `node`, not descending into their scripts. */
function scriptsIn(node: SyntaxNode, acc: { subs: Array<{ script: Script | undefined; label: string; text?: string }>; proc: boolean }): void {
  forEachChild(node, (c: SyntaxNode) => {
    const x = c as any;
    if (x.type === "CommandExpansion" || x.type === "ArithmeticCommandExpansion" || x.type === "ProcessSubstitution") {
      if (x.type === "ProcessSubstitution") acc.proc = true;
      acc.subs.push({ script: x.script, label: String(x.text).startsWith("`") ? "`" : "$(", text: String(x.text) });
      return;
    }
    scriptsIn(c, acc);
  });
}

/**
 * Pre-order, document order walk below `roots` without recursion (a deep tree cannot overflow the stack). `visit` returns false to skip the
 * children of a node, or an array of nodes to walk instead of them.
 */
function walkIter(roots: readonly SyntaxNode[], visit: (n: SyntaxNode) => boolean | readonly SyntaxNode[] | void): void {
  const stack: SyntaxNode[] = [...roots].reverse();
  while (stack.length) {
    const n = stack.pop()!;
    const r = visit(n);
    if (r === false) continue;
    const kids: SyntaxNode[] = [];
    if (Array.isArray(r)) kids.push(...(r as readonly SyntaxNode[]));
    else forEachChild(n, (c: SyntaxNode) => void kids.push(c));
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
}

const childrenOf = (n: SyntaxNode): SyntaxNode[] => {
  const kids: SyntaxNode[] = [];
  forEachChild(n, (c: SyntaxNode) => void kids.push(c));
  return kids;
};

/** `scriptsIn` for the nodes the walker does not enter: the same substitutions in the same order, without recursion. */
function subsIn(node: SyntaxNode, acc: { subs: Array<{ script: Script | undefined; label: string; text?: string }>; proc: boolean }): void {
  walkIter(childrenOf(node), (c) => {
    const x = c as any;
    if (x.type === "CommandExpansion" || x.type === "ArithmeticCommandExpansion" || x.type === "ProcessSubstitution") {
      if (x.type === "ProcessSubstitution") acc.proc = true;
      acc.subs.push({ script: x.script, label: String(x.text).startsWith("`") ? "`" : "$(", text: String(x.text) });
      return false;
    }
  });
}

function seg(sc: Scope, program: string, argv: string[], reason: OpaqueReason | null, c?: Cmd, cwd: string | null = sc.cwd, source?: string, computed?: boolean[], substitutions?: string[]): void {
  sc.run.out.push({
    ...(substitutions?.length ? { substitutions } : {}),
    ...(source === undefined ? {} : { source }),
    ...(computed ? { computed } : {}),
    ...(sc.time ? { afterTime: true } : {}),
    ...(sc.pipe ? { piped: true } : {}),
    ...(c?.envNames?.length ? { envNames: [...c.envNames] } : {}),
    program,
    argv,
    redirects: [...(c ? c.redirs : sc.redirects)],
    heredoc: c ? c.heredoc : sc.heredoc,
    stdinBodies: [...(c ? c.bodies : sc.bodies)],
    cwd,
    wrappers: [...sc.wrappers],
    opaque: reason ?? c?.reason ?? sc.reason,
  });
}

function walkSubs(subs: Array<{ script: Script | undefined; label: string; text?: string }>, sc: Scope): void {
  for (const s of subs) {
    if (sc.depth + 1 > MAX_DEPTH) seg(sc, s.label, [], "depth", undefined, sc.cwd, s.text);
    else if (!s.script || s.script.errors?.length) seg(sc, s.label, [], "parse_error", undefined, sc.cwd, s.text);
    else walkList(s.script.commands, { ...sc, depth: sc.depth + 1, wrappers: [...sc.wrappers, s.label], stdin: false, pipe: false, time: false, redirects: [], heredoc: false, bodies: [], reason: null });
  }
}

function redirectsOf(list: readonly Redirection[], c: Cmd, vars?: Map<string, string | undefined>): void {
  for (const r of list) {
    const d = r.descriptor;
    const fd = d ? (d.type === "FileDescriptor" ? String(d.value) : `{${d.name}}`) : null;
    const stdin = fd === null || fd === "0";
    if (r.type === "HereDoc" || r.type === "HereString") {
      c.heredoc = true;
      // the body of a heredoc or here-string on any descriptor is recorded (the guard reads them all as script)
      if (r.type === "HereDoc") c.bodies.push({ text: r.body.text, literal: true });
      else if (r.target) {
        const t = wordOf(r.target, vars);
        c.bodies.push(t.value !== null ? { text: t.value, literal: true } : { text: t.text, literal: false });
      }
      if (stdin) c.feeds = true;
      continue;
    }
    const t = r.target ? wordOf(r.target, vars) : { text: "", value: null, reason: "unsupported" as OpaqueReason };
    if (t.value === null) c.reason = pick(c.reason, t.reason);
    const target = t.value ?? t.text;
    let op: ShellRedirect["op"];
    if (r.operator === ">&" || r.operator === "<&") op = /^(\d+|-)$/.test(target) ? "dup" : r.operator === ">&" ? "&>" : "<";
    else op = r.operator as ShellRedirect["op"];
    if ((op === "<" || op === "<>") && stdin) c.feeds = true;
    c.redirs.push({ op, fd, target });
  }
}

function walkList(stmts: readonly Statement[], sc: Scope): string | null {
  let cwd = sc.cwd;
  for (const st of stmts) {
    // `time` applies to the pipeline it precedes, not to the commands inside a group, subshell or loop body
    const end = walkNode(st.command, { ...sc, cwd, time: false });
    if (!st.background) cwd = end;
  }
  return cwd;
}

/** Walks `lists` (branches of one construct); the cwd after is the start cwd unless a list changed it (then unknown). */
function walkLists(lists: Array<CompoundList | undefined>, sc: Scope): string | null {
  let cwd = sc.cwd;
  let changed = false;
  for (const l of lists) {
    if (!l) continue;
    if (walkList(l.commands, { ...sc, cwd }) !== cwd) {
      changed = true;
      cwd = null;
    }
  }
  return changed ? null : sc.cwd;
}

function walkWords(words: readonly Word[] | undefined, sc: Scope): void {
  const acc = { subs: [] as Array<{ script: Script | undefined; label: string; text?: string }>, proc: false };
  for (const w of words ?? []) scriptsIn(w, acc);
  walkSubs(acc.subs, sc);
}

/** The source text of the body of a node the walker does not enter (function, coproc, select, arithmetic for), when it has one. */
function bodyText(n: any, sc: Scope): string | undefined {
  const b = n.body;
  if (sc.src === undefined || !b || typeof b !== "object" || typeof b.pos !== "number" || typeof b.end !== "number") return undefined;
  let end: number = b.end;
  if (n.type === "Coproc") {
    // a coproc body ends before the text of its heredocs: take it through the terminator line
    walkIter([b as SyntaxNode], (x) => {
      const y = x as any;
      if (y.type === "HereDocBody" && typeof y.end === "number") {
        const nl = sc.src!.indexOf("\n", y.end);
        end = Math.max(end, nl < 0 ? sc.src!.length : nl);
      }
    });
  }
  return sc.src.slice(b.pos, end);
}

function walkNode(n: any, sc: Scope): string | null {
  switch (n.type) {
    case "Command":
      return doCommand(n as Command, sc);
    case "Pipeline":
      (n.commands as CommandNode[]).forEach((cmd, i) => walkNode(cmd, { ...sc, stdin: sc.stdin || i > 0, pipe: sc.pipe || i > 0, time: i === 0 && (n.prefixes ?? []).some((p: any) => p.type === "Time") }));
      return sc.cwd;
    case "AndOr": {
      let cwd = sc.cwd;
      (n.commands as CommandNode[]).forEach((cmd, i) => {
        const end = walkNode(cmd, { ...sc, cwd });
        cwd = n.operators[i] === "||" && end !== cwd ? null : end;
      });
      return cwd;
    }
    case "Redirected": {
      const c: Cmd = { sc, redirs: [...sc.redirects], heredoc: sc.heredoc, bodies: [...sc.bodies], feeds: sc.stdin, reason: sc.reason };
      redirectsOf(n.redirects, c);
      const acc = { subs: [] as Array<{ script: Script | undefined; label: string; text?: string }>, proc: false };
      for (const r of n.redirects as Redirection[]) scriptsIn(r, acc);
      walkSubs(acc.subs, sc);
      return walkNode(n.command, { ...sc, redirects: c.redirs, heredoc: c.heredoc, bodies: c.bodies, stdin: c.feeds, reason: acc.proc ? pick(c.reason, "process_substitution") : c.reason });
    }
    case "Subshell":
      walkList(n.body.commands, sc);
      return sc.cwd;
    case "BraceGroup":
      return walkList(n.body.commands, sc);
    case "CompoundList":
      return walkList(n.commands, sc);
    case "If":
      return walkLists([n.clause, n.then, ...n.elif.flatMap((e: any) => [e.clause, e.then]), n.else], sc);
    case "While":
      return walkLists([n.clause, n.body], sc);
    case "For": {
      walkWords(n.wordlist, sc);
      const nm = String(n.name.text);
      const listed = n.wordlist !== undefined && (n.wordlist as Word[]).every((w) => wordOf(w).value !== null);
      if (!(listed && (HARMLESS.has(nm) || nm.startsWith("LC_")))) seg(sc, "for", [], "assignment");
      return walkLists([n.body], sc);
    }
    case "Case": {
      walkWords([n.word, ...n.items.flatMap((i: any) => i.pattern)], sc);
      return walkLists(n.items.map((i: any) => i.body), sc);
    }
    case "Function":
      seg(sc, n.name.text, [], "function_def", undefined, sc.cwd, bodyText(n, sc));
      return sc.cwd;
    default: {
      const names: Record<string, string> = { Select: "select", Coproc: "coproc", ArithmeticFor: "for", TestCommand: "[[", ArithmeticCommand: "((" };
      const acc = { subs: [] as Array<{ script: Script | undefined; label: string; text?: string }>, proc: false };
      let text: string | undefined;
      // the optional fields only: a failure while collecting them leaves them unset and never changes the segment's other fields
      try {
        if (n.type === "Select") for (const w of (n.wordlist ?? []) as Word[]) subsIn(w, acc);
        else if (n.type === "TestCommand" || n.type === "ArithmeticCommand") subsIn(n, acc);
        // the header only: the body is read as text; an empty word stands in for it in the traversal
        else if (n.type === "ArithmeticFor") subsIn({ type: n.type, initialize: n.initialize, test: n.test, update: n.update, body: { type: "Word", parts: [] } } as unknown as SyntaxNode, acc);
        text = (n.type === "ArithmeticCommand" || n.type === "TestCommand") && sc.src !== undefined ? sc.src.slice(n.pos, n.end) : bodyText(n, sc);
      } catch {
        acc.subs = [];
        text = undefined;
      }
      seg(sc, names[n.type] ?? n.type, [], "unsupported", undefined, sc.cwd, text, undefined, acc.subs.map((s) => s.text ?? ""));
      return sc.cwd;
    }
  }
}

function doCommand(cmd: Command, sc: Scope): string | null {
  const vars = sc.run.vars.get(cmd);
  const c: Cmd = { sc, redirs: [...sc.redirects], heredoc: sc.heredoc, bodies: [...sc.bodies], feeds: sc.stdin || sc.heredoc, reason: sc.reason };
  const acc = { subs: [] as Array<{ script: Script | undefined; label: string; text?: string }>, proc: false };
  scriptsIn(cmd, acc);
  if (acc.proc) c.reason = pick(c.reason, "process_substitution");
  walkSubs(acc.subs, sc);

  const words: W[] = [];
  const prefix: W[] = [];
  for (const p of cmd.prefix) {
    if (p.type === "Assignment") prefix.push(assignW(p, vars));
    else redirectsOf([p], c, vars);
  }
  if (cmd.name) words.push(wordOf(cmd.name, vars));
  for (const s of cmd.suffix) {
    if (s.type === "Assignment") words.push(assignW(s, vars));
    else if (s.type === "Word") words.push(wordOf(s, vars));
    else redirectsOf([s], c, vars);
  }
  if (!cmd.name) {
    // standalone assignments (and bare redirects): harmless names, or the closed grammar's own assignment
    const ok = sc.run.assignOk.has(cmd) || prefix.every((a) => a.assign && harmless(a.assign));
    seg(sc, "", [], ok ? null : "assignment", c);
    return sc.cwd;
  }
  for (const a of prefix) if (!(a.assign && harmless(a.assign))) c.reason = pick(c.reason, "assignment");
  c.envNames = prefix.flatMap((a) => (a.assign ? [a.assign.name] : []));
  return run(words, c, sc.cwd);
}

/** Options of a wrapper: the leading `-x` words. A non-literal word ends them (it is the operand or command). */
function parseOpts(args: W[], s: OptSpec): { rest: W[]; opts: Opt[] } | OpaqueReason {
  const opts: Opt[] = [];
  let i = 0;
  while (i < args.length) {
    const v = args[i].value;
    if (v === null) break;
    if (v === "--") {
      i++;
      break;
    }
    if (!v.startsWith("-") || v === "-") break;
    if (s.numeric && /^-\d+$/.test(v)) {
      i++;
      continue;
    }
    if (v.startsWith("--")) {
      const eq = v.indexOf("=");
      const key = eq < 0 ? v : v.slice(0, eq);
      if (s.longArg?.includes(key)) {
        let val = eq >= 0 ? v.slice(eq + 1) : null;
        if (val === null) {
          const next = args[++i];
          if (!next || next.value === null) return "wrapper_option";
          val = next.value;
        }
        opts.push({ name: key, value: val });
      } else if (s.long?.includes(key)) opts.push({ name: key, value: eq >= 0 ? v.slice(eq + 1) : null });
      else return "wrapper_option";
      i++;
      continue;
    }
    for (let j = 1; j < v.length; j++) {
      const ch = v[j];
      if (s.arg?.includes(ch)) {
        let val = v.slice(j + 1);
        if (!val) {
          const next = args[++i];
          if (!next || next.value === null) return "wrapper_option";
          val = next.value;
        }
        opts.push({ name: `-${ch}`, value: val });
        break;
      }
      if (!s.flags?.includes(ch)) return "wrapper_option";
      opts.push({ name: `-${ch}`, value: null });
    }
    i++;
  }
  return { rest: args.slice(i), opts };
}

const has = (opts: Opt[], ...names: string[]): boolean => opts.some((o) => names.includes(o.name));
const val = (opts: Opt[], ...names: string[]): string | null => opts.find((o) => names.includes(o.name))?.value ?? null;

/** Emits the segment of a final (non-wrapper) program. */
function plain(prog: string, name: string, rest: W[], c: Cmd, cwd: string | null, stdinFlag = false): string | null {
  const sc = c.sc;
  const vals = rest.map((a) => a.value ?? "");
  let reason: OpaqueReason | null = null;
  if (FOREIGN.has(name) || FOREIGN_FILE.test(prog) || (INTERPRETERS.has(name) && vals.some((v) => FOREIGN_FILE.test(v)))) reason = "foreign_shell";
  else if (BUILTINS.has(name) || (name === "hash" && vals.some((v) => /^-[A-Za-z]*p/.test(v)))) reason = "shell_builtin";
  else if (name === "tee" || name === "script") reason = "writing_wrapper";
  else if (name === "unset" && !vals.every((v) => HARMLESS.has(v) || v.startsWith("LC_"))) reason = "assignment";
  else if (DECLARE.has(name) && declares(rest)) reason = "assignment";
  else if (ASSIGNING.has(name) || (name === "printf" && vals.some((v) => /^-[A-Za-z]*v/.test(v)))) reason = "assignment";
  else if (INTERPRETERS.has(name)) {
    const inline = !SHELLS.has(name) && vals.some((v) => INLINE.test(v));
    if (!inline && (stdinFlag || vals.includes("-") || c.feeds)) reason = "stdin_fed";
  }
  let at = cwd;
  if (name === "git") {
    for (let i = 0; i < rest.length; ) {
      const v = rest[i].value;
      if (v === "-C") {
        const d = rest[i + 1]?.value;
        at = d == null ? null : (cdTarget(["cd", d], at ?? undefined, win32(sc.run)) ?? null);
        i += 2;
      } else if (v === "-c") i += 2;
      else if (v?.startsWith("-")) i++;
      else break;
    }
  }
  const bad = rest.find((a) => a.value === null);
  seg(sc, prog, rest.map((a) => a.value ?? a.text), reason ?? bad?.reason ?? null, c, at, undefined, rest.map((a) => a.value === null));
  return cwd;
}

/** Parses `src` as a nested script (bash -c, eval, watch, flock -c) and walks it. */
function runString(label: string, src: string, c: Cmd, cwd: string | null): string | null {
  const sc: Scope = { ...c.sc, cwd, wrappers: [...c.sc.wrappers, label] };
  if (sc.depth + 1 > MAX_DEPTH) {
    seg(sc, label, [], "depth", c, cwd, src);
    return cwd;
  }
  let script: Script | undefined;
  try {
    script = parse(src);
  } catch {
    script = undefined;
  }
  if (!script || (script as any).errors?.length) {
    seg(sc, label, [src], "parse_error", c, cwd, src);
    return cwd;
  }
  // the guard reads a nested script with the heredocs of no command (`watch sh <<EOF` hands the body to nobody it reads), so `bodies` starts empty
  walkScript(script, src, { ...sc, time: false, depth: sc.depth + 1, redirects: c.redirs, heredoc: c.heredoc, bodies: [], stdin: c.feeds, reason: c.reason });
  return cwd;
}

/** One command whose words are resolved: unwrap the wrappers, emit the segment of the program. */
function run(words: W[], c: Cmd, cwd: string | null): string | null {
  const sc = c.sc;
  const p = words[0];
  const rest = words.slice(1);
  if (p.value === null) {
    seg(sc, p.text, rest.map((a) => a.value ?? a.text), p.reason ?? "unresolved_var", c, cwd, undefined, rest.map((a) => a.value === null));
    return cwd;
  }
  const prog = p.value;
  const name = baseName(prog);
  const wrap = (inner: W[], w: string, at = cwd): string | null => {
    if (!inner.length) return plain(prog, name, [], c, cwd);
    return run(inner, { ...c, sc: { ...sc, wrappers: [...sc.wrappers, w] } }, at);
  };
  const bad = (reason: OpaqueReason): string | null => {
    seg(sc, prog, rest.map((a) => a.value ?? a.text), reason, c, cwd, undefined, rest.map((a) => a.value === null));
    return cwd;
  };
  const opts = (spec: OptSpec) => parseOpts(rest, spec);
  const strOf = (list: W[]): string | null => (list.every((a) => a.value !== null) ? list.map((a) => a.value).join(" ") : null);
  if (FOREIGN.has(name) || FOREIGN_FILE.test(prog)) return plain(prog, name, rest, c, cwd);

  switch (name) {
    case "cd": {
      plain(prog, name, rest, c, cwd);
      const one = rest.length === 1 && rest[0].value !== null ? rest[0].value : null;
      return one === null ? null : (cdTarget(["cd", one], cwd ?? undefined, win32(sc.run)) ?? null);
    }
    case "pushd":
    case "popd":
      plain(prog, name, rest, c, cwd);
      return null;
    case "zsh":
      return bad("foreign_shell");
    case "bash":
    case "sh":
    case "dash":
    case "ksh":
    case "ash": {
      let i = 0;
      let cflag = false;
      let sflag = false;
      for (; i < rest.length; i++) {
        const v = rest[i].value;
        if (v === null) return bad(cflag ? "nonliteral_script" : (rest[i].reason ?? "unresolved_var"));
        if (v === "--") {
          i++;
          break;
        }
        if (v.startsWith("--")) {
          if (!["--login", "--noprofile", "--norc", "--posix", "--restricted", "--verbose", "--noediting"].includes(v)) return bad("wrapper_option");
        } else if (/^[-+][A-Za-z]/.test(v)) {
          for (const ch of v.slice(1)) {
            if (ch === "c") cflag = true;
            else if (ch === "s") sflag = true;
            else if (ch === "o" || ch === "O") i++;
          }
        } else break;
      }
      if (!cflag) return plain(prog, name, rest, c, cwd, sflag);
      const script = rest[i];
      if (!script) return plain(prog, name, rest, c, cwd);
      if (script.value === null) return bad("nonliteral_script");
      return runString(name, script.value, c, cwd);
    }
    case "eval": {
      if (!rest.length) return plain(prog, name, rest, c, cwd);
      const s = strOf(rest);
      return s === null ? bad("nonliteral_script") : runString("eval", s, c, cwd);
    }
    case "env": {
      const o = opts({ flags: "i0v", arg: "uC", long: ["--ignore-environment", "--null", "--debug", "--verbose"], longArg: ["--unset", "--chdir"] });
      if (typeof o === "string") return bad(o);
      let args = o.rest;
      if (args[0]?.value === "-") args = args.slice(1);
      let at = cwd;
      const dir = val(o.opts, "-C", "--chdir");
      if (dir !== null) at = cdTarget(["cd", dir], cwd ?? undefined, win32(sc.run)) ?? null;
      while (args.length && (args[0].assign ?? asAssign(args[0]))) {
        c.envNames = [...(c.envNames ?? []), (args[0].assign ?? asAssign(args[0]))!.name];
        if (!harmless((args[0].assign ?? asAssign(args[0]))!)) c.reason = pick(c.reason, "assignment");
        args = args.slice(1);
      }
      wrap(args, "env", at);
      return cwd;
    }
    case "timeout": {
      const o = opts({ flags: "v", arg: "ks", long: ["--foreground", "--preserve-status", "--verbose"], longArg: ["--kill-after", "--signal"] });
      if (typeof o === "string") return bad(o);
      if (o.rest[0] && o.rest[0].value === null) return bad(o.rest[0].reason ?? "unresolved_var");
      return wrap(o.rest.slice(1), "timeout");
    }
    case "nice": {
      const o = opts({ arg: "n", numeric: true, longArg: ["--adjustment"] });
      return typeof o === "string" ? bad(o) : wrap(o.rest, "nice");
    }
    case "nohup": {
      const o = opts({});
      if (typeof o === "string") return bad(o);
      if (!c.redirs.some((r) => [">", ">>", "&>", "&>>"].includes(r.op) && (r.fd === null || r.fd === "1"))) c.reason = pick(c.reason, "writing_wrapper");
      return wrap(o.rest, "nohup");
    }
    case "xargs": {
      const o = opts({
        flags: "0oprtxXvil",
        arg: "aIEdLnPsSRJ",
        long: ["--null", "--open-tty", "--interactive", "--no-run-if-empty", "--verbose", "--exit", "--show-limits", "--replace", "--eof", "--max-lines"],
        longArg: ["--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"],
      });
      if (typeof o === "string") return bad(o);
      c.reason = pick(c.reason, "xargs_stdin");
      if (!o.rest.length) {
        seg({ ...sc, wrappers: [...sc.wrappers, "xargs"] }, "echo", [], null, c, cwd);
        return cwd;
      }
      return wrap(o.rest, "xargs");
    }
    case "time": {
      const o = opts({ flags: "pvalhq", arg: "fo", long: ["--portability", "--verbose", "--append", "--quiet"], longArg: ["--format", "--output"] });
      if (typeof o === "string") return bad(o);
      if (has(o.opts, "-o", "--output")) c.reason = pick(c.reason, "writing_wrapper");
      return wrap(o.rest, "time");
    }
    case "command": {
      const o = opts({ flags: "pvV" });
      if (typeof o === "string" || has(o.opts, "-v", "-V")) return plain(prog, name, rest, c, cwd);
      return wrap(o.rest, "command");
    }
    case "stdbuf": {
      const o = opts({ arg: "ioe", longArg: ["--input", "--output", "--error"] });
      return typeof o === "string" ? bad(o) : wrap(o.rest, "stdbuf");
    }
    case "setsid": {
      const o = opts({ flags: "cfw", long: ["--ctty", "--fork", "--wait"] });
      return typeof o === "string" ? bad(o) : wrap(o.rest, "setsid");
    }
    case "watch": {
      const o = opts({
        flags: "bcCdegptwxrvh",
        arg: "nq",
        long: ["--beep", "--color", "--no-color", "--differences", "--errexit", "--chgexit", "--precise", "--no-title", "--no-linewrap", "--exec", "--no-rerun", "--version", "--help"],
        longArg: ["--interval", "--equexit"],
      });
      if (typeof o === "string") return bad(o);
      if (has(o.opts, "-x", "--exec")) return wrap(o.rest, "watch");
      if (!o.rest.length) return plain(prog, name, rest, c, cwd);
      const s = strOf(o.rest);
      return s === null ? bad("nonliteral_script") : runString("watch", s, c, cwd);
    }
    case "flock": {
      const o = opts({ flags: "sexunoF", arg: "wEc", long: ["--shared", "--exclusive", "--unlock", "--nonblock", "--nb", "--close", "--no-fork"], longArg: ["--timeout", "--wait", "--conflict-exit-code", "--command"] });
      if (typeof o === "string") return bad(o);
      const file = o.rest[0];
      if (file && !/^\d+$/.test(file.value ?? "")) c.reason = pick(c.reason, "writing_wrapper");
      if (has(o.opts, "-c", "--command")) return runString("flock", val(o.opts, "-c", "--command") ?? "", c, cwd);
      if (file && (o.rest[1]?.value === "-c" || o.rest[1]?.value === "--command")) {
        const s = o.rest[2];
        return !s || s.value === null || o.rest.length > 3 ? bad("nonliteral_script") : runString("flock", s.value, c, cwd);
      }
      return o.rest.length > 1 ? wrap(o.rest.slice(1), "flock") : plain(prog, name, rest, c, cwd);
    }
    default:
      if (RUNNERS.has(name) && !BUILTINS.has(name) && name !== "script") return bad(runnerReason(name));
      return plain(prog, name, rest, c, cwd);
  }
}

/** The line holds a function definition, or a command that runs code or text (`eval`, `source`, `.`, a runner, a computed program name). */
function runsCode(node: SyntaxNode): boolean {
  let found = false;
  const visit = (n: SyntaxNode): void => {
    if (found) return;
    const x = n as any;
    if (x.type === "Function") found = true;
    else if (x.type === "Command" && x.name && (/[$`]/.test(x.name.text) || RUNNERS.has(baseName(x.name.value ?? x.name.text)))) found = true;
    else forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * A7, children only (a child scratch binding in `env`): the sole literal assignments of a flat script that stand at a top-level unconditional statement
 * position, name -> [value, end offset, the assignment command]. The position rule is here (the AST), the form and mention rules are shellvars.ts
 * `childAssignValues`. A line that runs code or text (`runsCode`) gets none.
 */
function childAssigns(script: Script, src: string, rn: Run): Map<string, [string, number, Command]> {
  const out = new Map<string, [string, number, Command]>();
  if (!rn.env.FOREMAN_SCRATCH || runsCode(script)) return out;
  const plain = (n: any): boolean => n.type === "Command" && !n.name && n.prefix.length === 1 && n.prefix[0].type === "Assignment" && n.suffix.length === 0;
  const cands: ChildAssign[] = [];
  const cmdAt = new Map<number, Command>();
  for (const st of script.commands) {
    if (st.background) continue;
    const node: any = st.command;
    const parts: any[] = node.type === "AndOr" ? node.commands : [node];
    // line start or after `;` / newline (a statement of its own), and after `&&` only following another such assignment
    for (let k = 0; k < parts.length && plain(parts[k]); k++) {
      const a = parts[k].prefix[0] as Assignment;
      cands.push({ name: a.name, pos: a.pos, end: a.end });
      cmdAt.set(a.pos, parts[k]);
      if (node.operators?.[k] !== "&&") break;
    }
  }
  for (const [name, [value, end]] of childAssignValues(src, cands, rn.env, rn.platform)) {
    const c = cands.find((x) => x.name === name)!;
    out.set(name, [value, end, cmdAt.get(c.pos)!]);
  }
  return out;
}

/** The variable pre-pass for a flat script: `resolveVars` values per command, and the assignments the closed grammar accepts. */
function prepare(script: Script, src: string, sc: Scope): void {
  const rn = sc.run;
  const pipes: string[][][] = [];
  const cmds: Array<Command | null> = [];
  const probes: Array<{ cmd: Command; names: string[]; unit: string[] }> = [];
  const unitOf = (n: any): string[] => {
    if (n.type !== "Command") return ["$?"];
    const cmd = n as Command;
    const ws = [...(cmd.name ? [cmd.name] : []), ...cmd.suffix.filter((s): s is Word => s.type === "Word")];
    return ws.length ? ws.map((w) => (!w.parts || w.parts.every((p: any) => ["Literal", "DoubleQuoted", "SimpleExpansion", "ParameterExpansion"].includes(p.type)) ? w.value : "$?")) : ["x"];
  };
  const namesOf = (cmd: Command): string[] => {
    const names = new Set<string>();
    const part = (p: any): void => {
      if (p.type === "SimpleExpansion") names.add(String(p.text).slice(1));
      else if (p.type === "ParameterExpansion" && p.parameter) names.add(p.parameter);
      else if (p.type === "DoubleQuoted") p.parts.forEach(part);
    };
    for (const w of [...(cmd.name ? [cmd.name] : []), ...cmd.suffix.filter((s): s is Word => s.type === "Word"), ...cmd.redirects.flatMap((r) => (r.type !== "HereDoc" && r.target ? [r.target] : []))]) w.parts?.forEach(part);
    return [...names];
  };
  for (const st of script.commands) {
    const node: any = st.command;
    for (const pn of node.type === "AndOr" ? node.commands : [node]) {
      if (pn.type === "Pipeline") {
        const pipe = pn.commands.map(unitOf);
        // a pipeline stage is probed like a statement: only the child assignment substitution (A7) resolves anything in it
        for (const stage of pn.commands) {
          const names = stage.type === "Command" ? namesOf(stage as Command) : [];
          if (names.length) {
            const unit = names.map((n) => `$${n}`);
            pipe.push(unit);
            probes.push({ cmd: stage as Command, names, unit });
          }
        }
        pipes.push(pipe);
        cmds.push(null);
      } else {
        const pipe = [unitOf(pn)];
        const cmd = pn.type === "Command" ? (pn as Command) : null;
        const names = cmd ? namesOf(cmd) : [];
        if (cmd && names.length) {
          const unit = names.map((n) => `$${n}`);
          pipe.push(unit);
          probes.push({ cmd, names, unit });
        }
        pipes.push(pipe);
        cmds.push(cmd);
      }
    }
  }
  const env = { ...rn.env };
  if (sc.cwd) env.PWD = sc.cwd;
  const res = resolveVars(pipes, [], env, () => false, src, rn.platform);
  const child = childAssigns(script, src, rn);
  for (const [, , cmd] of child.values()) rn.assignOk.add(cmd);
  // the harness constant `$FOREMAN_SCRATCH` of a child resolves on any line that never rebinds it (a heredoc or pipe leaves the closed grammar)
  const scratchConst = !!rn.env.FOREMAN_SCRATCH && !runsCode(script) && [...src.matchAll(/(?<![A-Za-z0-9_])FOREMAN_SCRATCH(?![A-Za-z0-9_])/g)].every((m) => (src[m.index! - 1] === "$" || (src.slice(m.index! - 2, m.index!) === "${" && src[m.index! + 15] === "}")));
  for (const pr of probes) {
    const got = res.get(pr.unit);
    const later = (n: string): string | undefined => {
      if (n === "FOREMAN_SCRATCH" && scratchConst) return rn.env.FOREMAN_SCRATCH;
      const c = child.get(n);
      return c && c[1] <= pr.cmd.pos ? c[0] : undefined;
    };
    rn.vars.set(pr.cmd, new Map(pr.names.map((n, k) => [n, got && got[k] !== `$${n}` ? got[k] : later(n)])));
  }
  const stmts = grammarStatements(headerOf(src), rn.platform);
  cmds.forEach((cmd, i) => {
    if (cmd && !cmd.name && stmts && stmts[i]) rn.assignOk.add(cmd);
  });
}

function walkScript(script: Script, src: string, sc: Scope): void {
  prepare(script, src, sc);
  walkList(script.commands, { ...sc, src });
}

export interface LineWord {
  /** The word with quotes removed and its command, arithmetic and `$name` expansions cut out (what the guard's lexer keeps of it). */
  text: string;
  /** The word is the program of a command. */
  program: boolean;
  /** The word holds an expansion (its value is computed). */
  expands: boolean;
}

/**
 * Every word of the line as the parser reads it, wherever it stands (command words, `case` patterns, `[[ ]]` operands, function bodies, here-string
 * words, heredoc bodies, assignments, nested substitutions); not redirect targets and not comments. Null when the line does not parse.
 */
export function lineWords(command: string): LineWord[] | null {
  let script: Script | undefined;
  try {
    script = parse(command);
  } catch {
    return null;
  }
  if (!script || (script as any).errors?.length) return null;
  const out: LineWord[] = [];
  const programs = new Set<unknown>();
  const expansions = (n: SyntaxNode, acc: string[]): void =>
    walkIter(childrenOf(n), (c) => {
      const x = c as any;
      if (x.type === "CommandExpansion" || x.type === "ArithmeticExpansion" || x.type === "SimpleExpansion" || x.type === "ProcessSubstitution") {
        acc.push(String(x.text));
        return false;
      }
    });
  const visit = (n: SyntaxNode): boolean | readonly SyntaxNode[] | void => {
    const x = n as any;
    if (x.type === "Command" && x.name) programs.add(x.name);
    if (x.type === "Assignment") out.push({ text: `${x.name}=`, program: false, expands: false });
    if (x.type === "HereDocBody") out.push({ text: String(x.text), program: false, expands: false });
    if (x.type === "Word") {
      const cut: string[] = [];
      expansions(n, cut);
      let text = String(x.value ?? x.text);
      for (const e of cut) text = text.replace(e, "");
      out.push({ text, program: programs.has(n), expands: cut.length > 0 });
    }
    // a redirect target is a file name, not a word of the command; what it expands is still walked
    if (x.target && x.operator && x.type !== "HereString" && x.type !== "HereDoc") {
      return childrenOf(x.target as SyntaxNode);
    }
  };
  try {
    walkIter([script as unknown as SyntaxNode], visit);
  } catch {
    // a failure leaves the words found so far
  }
  return out;
}

/** The text of every arithmetic expansion `$(( ... ))` the parser finds in `command` (also inside quotes and substitutions; none in single quotes, comments or escaped text). */
export function arithmeticTexts(command: string): string[] {
  const out: string[] = [];
  let script: Script | undefined;
  try {
    script = parse(command);
  } catch {
    return out;
  }
  try {
    walkIter([script as unknown as SyntaxNode], (n) => {
      const x = n as any;
      if (x.type === "ArithmeticExpansion" && typeof x.text === "string") out.push(x.text);
    });
  } catch {
    // a failure leaves the texts found so far
  }
  return out;
}

/**
 * Parses `command` into segments (see the header). A parse error is one opaque `parse_error` segment; an empty line has none.
 */
export function parseShell(command: string, opts: ShellParseOptions = {}): ShellSegment[] {
  const run: Run = { out: [], vars: new Map(), assignOk: new Set(), env: opts.env ?? {}, platform: opts.platform ?? process.platform };
  const sc: Scope = { run, cwd: opts.cwd ?? null, wrappers: [], depth: 0, stdin: false, redirects: [], heredoc: false, bodies: [], reason: null };
  let script: Script | undefined;
  try {
    script = parse(command);
  } catch {
    script = undefined;
  }
  if (!script || (script as any).errors?.length) {
    seg(sc, "", [], "parse_error", undefined, sc.cwd, command);
    return run.out;
  }
  walkScript(script, command, sc);
  return run.out;
}
