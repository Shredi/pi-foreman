/**
 * A bash command line as a list of segments (round 41, A1), on top of the `unbash` parser. One segment is one simple
 * command that would run: chains, pipelines, `$(...)`, backticks, subshells, `bash -c` / `sh -c` / `eval` with a
 * literal string and the wrappers env, timeout, nice, nohup, xargs, time, command, exec, stdbuf, setsid, watch, flock -c are
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
  /** Set on a `dup` written `<&` (an input dup: it replaces the fd's input). */
  input?: true;
}

export interface ShellSegment {
  program: string;
  argv: string[];
  redirects: ShellRedirect[];
  heredoc: boolean;
  /** Set (true) only when stdin is fed by a pipe, a heredoc, a here-string, `<` or `<>`; an fd dup onto stdin (`<&3`) is not counted. */
  stdinFed?: boolean;
  /** Set (not enumerable) by the walker: the command text ends in its last redirect, nothing follows its target (`echo > $F` yes, `echo > $F arg` no). Read as true when unset. */
  redirectEnd?: boolean;
  cwd: string | null;
  /** The wrappers this segment was unwrapped from, outermost first (`env`, `bash`, `$(`, backtick ...). */
  wrappers: string[];
  /** Set (not enumerable) by `wrap()`: the indexes into `wrappers` of the wrappers the walker unwrapped to the command they wrap and that run no text of their own (`env`, `nohup`, `timeout` ...). */
  passThrough?: number[];
  opaque: OpaqueReason | null;
  /** Set (not enumerable) on a segment that stands for a function, select, coproc or arithmetic for, or a nested string too deep to walk: the source text of the bodies it holds. */
  bodies?: string[];
  /** Set (not enumerable) with `bodies`: the harness constants (`FOREMAN_SCRATCH`, `FOREMAN_OUT`) the line they stand in still reads as constants; a body is parsed with only these. */
  bodyConsts?: string[];
  /** Set (not enumerable): the texts of the here-documents and here-strings that feed stdin (`bash <<'E'` runs its body as code). */
  heredocs?: string[];
  /** Set (not enumerable) on a segment that is a stage of a `|` / `|&` pipeline: the pipeline's id (one per parse) and the stage's index; unset for any other command, and for a command inside a substitution of a stage. */
  pipeline?: { id: number; stage: number };
  /** Set (not enumerable): the indexes into `argv` of the words that are not literal (a parameter, command or arithmetic expansion in them). */
  dynamicArgs?: number[];
  /** Set (true, not enumerable): one of the here-documents or here-strings in `heredocs` has an expansion in it, so the text the interpreter reads is not the text in the command. */
  dynamicCode?: boolean;
  /** Set (true, not enumerable) on a `$( )` the walker stopped at on MAX_DEPTH with a script inside it: that script was never walked. */
  tooDeep?: boolean;
}

export interface ShellParseOptions {
  /** The directory the line starts in (`$PWD` for the variable grammar). */
  cwd?: string | null;
  /** The harness env the variable grammar reads (`FOREMAN_SCRATCH`, `FOREMAN_OUT`). */
  env?: Record<string, string>;
  /** Defaults to process.platform; "win32" switches on the drive-path forms of shellvars.ts. */
  platform?: string;
}

export const MAX_DEPTH = 4;

/**
 * Whether a shell given these arguments (and no `-c` string) reads its program from stdin: it has no script operand, or `-s` says so. The options that take a value
 * (`-o name`, `-O name`, also inside a cluster such as `-euo pipefail`) are stepped over as the walker's own shell case steps over them.
 */
export function shellReadsStdin(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--") return i + 1 >= argv.length;
    if (v === "-") return true;
    if (v.startsWith("--")) continue;
    if (!/^[-+][A-Za-z]/.test(v)) return false;
    for (const ch of v.slice(1)) {
      if (ch === "s" && v[0] === "-") return true;
      if (ch === "o" || ch === "O") i++;
    }
  }
  return true;
}

const HARMLESS = new Set(["LANG", "TZ", "NO_COLOR", "FORCE_COLOR", "CI", "DEBUG", "NODE_ENV", "PYTHONDONTWRITEBYTECODE", "GIT_PAGER", "PAGER"]);
export const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash"]);
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
  /** The text of every string the parser ran as a script (`-c`, `eval` ...) behind whatever wrappers and path stood before the shell. */
  strings: string[];
  /** The whole line being parsed (a nested string is walked with its own `src`). */
  root?: string;
  /** Pipelines numbered so far (`ShellSegment.pipeline`). */
  pipes?: number;
  /** The heredoc and here-string texts a shell expands (an unquoted tag with an expansion in the body, a here-string word that is not literal): `ShellSegment.dynamicCode`. */
  dynDocs?: Set<string>;
  /** A trial walk (see `passNames`): `$FOREMAN_SCRATCH` and `$FOREMAN_OUT` are not resolved as constants and no trial of its own starts. */
  trial?: boolean;
}

interface Scope {
  run: Run;
  cwd: string | null;
  wrappers: string[];
  /** Indexes into `wrappers` of the pass-through wrappers (see `ShellSegment.passThrough`). */
  passAt?: number[];
  /** Names an env-clearing wrapper (`env -i`, `env -`, `env -u NAME`, `exec -c`) took out of the environment of what it runs; `*` is every name. A nested `-c` string under it sees them empty. */
  cleared?: string[];
  /** The harness constants the script being walked reads as constants (set by `prepare`). */
  consts?: string[];
  depth: number;
  /** stdin comes from a pipe, a heredoc, a here-string or `<`. */
  stdin: boolean;
  redirects: ShellRedirect[];
  heredoc: boolean;
  /** The texts of the here-documents and here-strings on stdin. */
  docs: string[];
  reason: OpaqueReason | null;
  /** The pipeline stage the commands walked here belong to (`ShellSegment.pipeline`). */
  pipe?: { id: number; stage: number };
  /** The source text of the script being walked (set by `walkScript`), for the body slices. */
  src?: string;
}

/** One simple command being resolved. */
interface Cmd {
  sc: Scope;
  redirs: ShellRedirect[];
  heredoc: boolean;
  docs: string[];
  feeds: boolean;
  reason: OpaqueReason | null;
  /** The command text ends in its last redirect (nothing follows the redirect target); true for redirects inherited from a compound command. */
  redirectEnd?: boolean;
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
  /** A word with an expansion in it: the literal text after the last expansion, when it holds a path separator (`$V/bin/pip` is `/bin/pip`). */
  tail?: string;
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
  // the literal text after the last expansion, unquoted as `out` is: `$V/bin/r"m"` has the tail `/bin/rm` (a computed command word still names its program by it)
  let tail = "";
  let expanded = false;
  // a glob, a substitution or another computed part: the word names no program by its tail (`$(npm root -g)/git` stays a computed command word)
  let computed = false;
  const brk = (r: OpaqueReason, comp = false): void => {
    note(r);
    tail = "";
    expanded = true;
    if (comp) computed = true;
  };
  const ref = (name: string): void => {
    const v = vars?.get(name);
    if (v === undefined) brk("unresolved_var");
    else {
      out += v;
      tail += v;
    }
  };
  const part = (p: any): void => {
    switch (p.type) {
      case "Literal":
      case "SingleQuoted":
        out += p.value;
        tail += p.value;
        return;
      case "DoubleQuoted":
        for (const c of p.parts) part(c);
        return;
      case "SimpleExpansion":
        ref(String(p.text).slice(1));
        return;
      case "ParameterExpansion":
        if (!p.operation && !p.prefix && !p.index) ref(p.parameter);
        else brk("unresolved_var");
        return;
      case "Glob":
      case "ExtendedGlob":
      case "BraceExpansion":
        brk("glob_target", true);
        return;
      case "ProcessSubstitution":
        brk("process_substitution", true);
        return;
      default:
        brk("unresolved_var", true);
    }
  };
  if (w.text.startsWith("~")) note("unresolved_var"); // bash expands an unquoted tilde
  if (w.parts) for (const p of w.parts) part(p);
  else out = w.value;
  return { text: w.text, value: reason ? null : out, reason, ...(reason && expanded && !computed && /[\\/]/.test(tail) ? { tail } : {}) };
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
function scriptsIn(node: SyntaxNode, acc: { subs: Array<{ script: Script | undefined; label: string }>; proc: boolean }): void {
  forEachChild(node, (c: SyntaxNode) => {
    const x = c as any;
    if (x.type === "CommandExpansion" || x.type === "ArithmeticCommandExpansion" || x.type === "ProcessSubstitution") {
      if (x.type === "ProcessSubstitution") acc.proc = true;
      acc.subs.push({ script: x.script, label: String(x.text).startsWith("`") ? "`" : "$(" });
      return;
    }
    scriptsIn(c, acc);
  });
}

function seg(sc: Scope, program: string, argv: string[], reason: OpaqueReason | null, c?: Cmd, cwd: string | null = sc.cwd): void {
  const out: ShellSegment = {
    program,
    argv,
    redirects: [...(c ? c.redirs : sc.redirects)],
    heredoc: c ? c.heredoc : sc.heredoc,
    cwd,
    wrappers: [...sc.wrappers],
    opaque: reason ?? c?.reason ?? sc.reason,
  };
  // not enumerable: a segment's own keys (and so its serialised form and the pinned digests) stay as they were
  // always set (true or false): a clone that lost the property reads as undefined, which protected.ts treats as fed
  Object.defineProperty(out, "stdinFed", { value: Boolean(c ? c.feeds : sc.stdin), enumerable: false });
  // not enumerable either: the old delete check read a `> $X` only when the target ended the command (`echo > $F arg` is none)
  Object.defineProperty(out, "redirectEnd", { value: c?.redirectEnd ?? true, enumerable: false });
  Object.defineProperty(out, "passThrough", { value: [...(sc.passAt ?? [])], enumerable: false, configurable: true });
  Object.defineProperty(out, "heredocs", { value: [...(c ? c.docs : sc.docs)], enumerable: false, configurable: true });
  const dyn = sc.run.dynDocs;
  if (dyn && out.heredocs!.some((d) => dyn.has(d))) Object.defineProperty(out, "dynamicCode", { value: true, enumerable: false });
  if (sc.pipe) Object.defineProperty(out, "pipeline", { value: sc.pipe, enumerable: false, configurable: true });
  sc.run.out.push(out);
}

/** Hangs the body texts on the segment just emitted (not enumerable: a segment's own keys stay as they were). */
function withBodies(sc: Scope, bodies: string[]): void {
  const last = sc.run.out[sc.run.out.length - 1];
  if (last && bodies.length > 0) {
    Object.defineProperty(last, "bodies", { value: bodies, enumerable: false });
    Object.defineProperty(last, "bodyConsts", { value: [...(sc.consts ?? [])], enumerable: false });
  }
}

function walkSubs(subs: Array<{ script: Script | undefined; label: string }>, sc: Scope): void {
  for (const s of subs) {
    if (sc.depth + 1 > MAX_DEPTH) {
      seg(sc, s.label, [], "depth");
      // the script inside was never walked: a consumer must not read the segment as a plain unresolved word
      if (s.script && s.script.commands.length > 0) Object.defineProperty(sc.run.out[sc.run.out.length - 1], "tooDeep", { value: true, enumerable: false });
    }
    else if (!s.script || s.script.errors?.length) seg(sc, s.label, [], "parse_error");
    else walkList(s.script.commands, { ...sc, depth: sc.depth + 1, wrappers: [...sc.wrappers, s.label], stdin: false, redirects: [], heredoc: false, docs: [], reason: null, pipe: undefined });
  }
}

function redirectsOf(list: readonly Redirection[], c: Cmd, vars?: Map<string, string | undefined>): void {
  for (const r of list) {
    const d = r.descriptor;
    const fd = d ? (d.type === "FileDescriptor" ? String(d.value) : `{${d.name}}`) : null;
    const stdin = fd === null || fd === "0";
    if (r.type === "HereDoc" || r.type === "HereString") {
      c.heredoc = true;
      if (stdin) {
        c.feeds = true;
        const dyn = (c.sc.run.dynDocs ??= new Set());
        if (r.type === "HereDoc") {
          c.docs.push(r.body.text);
          if (!r.delimiter?.quoted && r.body.parts?.some((p: any) => p.type !== "Literal")) dyn.add(r.body.text);
        } else if (r.target) {
          const w = wordOf(r.target, vars);
          const text = w.value ?? w.text.replace(/^(["'])([\s\S]*)\1$/, "$2");
          c.docs.push(text);
          if (w.value === null) dyn.add(text);
        }
      }
      continue;
    }
    const t = r.target ? wordOf(r.target, vars) : { text: "", value: null, reason: "unsupported" as OpaqueReason };
    if (t.value === null) c.reason = pick(c.reason, t.reason);
    const target = t.value ?? t.text;
    let op: ShellRedirect["op"];
    if (r.operator === ">&" || r.operator === "<&") op = /^(\d+|-)$/.test(target) ? "dup" : r.operator === ">&" ? "&>" : "<";
    else op = r.operator as ShellRedirect["op"];
    if ((op === "<" || op === "<>") && stdin) c.feeds = true;
    c.redirs.push(op === "dup" && r.operator === "<&" ? { op, fd, target, input: true } : { op, fd, target });
  }
}

function walkList(stmts: readonly Statement[], sc: Scope): string | null {
  let cwd = sc.cwd;
  for (const st of stmts) {
    const end = walkNode(st.command, { ...sc, cwd });
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
  const acc = { subs: [] as Array<{ script: Script | undefined; label: string }>, proc: false };
  for (const w of words ?? []) scriptsIn(w, acc);
  walkSubs(acc.subs, sc);
}

function walkNode(n: any, sc: Scope): string | null {
  switch (n.type) {
    case "Command":
      return doCommand(n as Command, sc);
    case "Pipeline": {
      let docs = sc.docs;
      const id = (sc.run.pipes = (sc.run.pipes ?? 0) + 1);
      (n.commands as CommandNode[]).forEach((cmd, i) => {
        const before = sc.run.out.length;
        walkNode(cmd, { ...sc, docs, stdin: sc.stdin || i > 0, pipe: { id, stage: i } });
        // a here-document of one command flows down the pipe: the shell at the end of `cat <<E | bash` reads its body as code
        const fed = sc.run.out.slice(before).flatMap((x) => x.heredocs ?? []);
        if (fed.length) docs = [...new Set([...docs, ...fed])];
      });
      return sc.cwd;
    }
    case "AndOr": {
      let cwd = sc.cwd;
      (n.commands as CommandNode[]).forEach((cmd, i) => {
        const end = walkNode(cmd, { ...sc, cwd });
        cwd = n.operators[i] === "||" && end !== cwd ? null : end;
      });
      return cwd;
    }
    case "Redirected": {
      const c: Cmd = { sc, redirs: [...sc.redirects], heredoc: sc.heredoc, docs: [...sc.docs], feeds: sc.stdin, reason: sc.reason };
      redirectsOf(n.redirects, c);
      const acc = { subs: [] as Array<{ script: Script | undefined; label: string }>, proc: false };
      for (const r of n.redirects as Redirection[]) scriptsIn(r, acc);
      walkSubs(acc.subs, sc);
      return walkNode(n.command, { ...sc, redirects: c.redirs, heredoc: c.heredoc, docs: c.docs, stdin: c.feeds, reason: acc.proc ? pick(c.reason, "process_substitution") : c.reason });
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
      seg(sc, n.name.text, [], "function_def");
      withBodies(sc, nodeBodies(n, sc.src ?? ""));
      return sc.cwd;
    default: {
      const names: Record<string, string> = { Select: "select", Coproc: "coproc", ArithmeticFor: "for", TestCommand: "[[", ArithmeticCommand: "((" };
      seg(sc, names[n.type] ?? n.type, [], "unsupported");
      withBodies(sc, nodeBodies(n, sc.src ?? ""));
      return sc.cwd;
    }
  }
}

function doCommand(cmd: Command, sc: Scope): string | null {
  const vars = sc.run.vars.get(cmd);
  const c: Cmd = { sc, redirs: [...sc.redirects], heredoc: sc.heredoc, docs: [...sc.docs], feeds: sc.stdin || sc.heredoc, reason: sc.reason };
  const acc = { subs: [] as Array<{ script: Script | undefined; label: string }>, proc: false };
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
  const own = c.redirs.length - sc.redirects.length;
  const tail = cmd.suffix[cmd.suffix.length - 1];
  // the redirect ends the command when its node reaches the end of the command node (nothing follows the target inside the command)
  const closes = tail && "end" in tail && typeof tail.end === "number" && typeof cmd.end === "number" ? tail.end >= cmd.end : true;
  c.redirectEnd = own === 0 || (tail ? tail.type !== "Word" && tail.type !== "Assignment" && tail.type !== "HereDoc" && tail.type !== "HereString" && closes : !cmd.name);
  if (!cmd.name) {
    // standalone assignments (and bare redirects): harmless names, or the closed grammar's own assignment
    const ok = sc.run.assignOk.has(cmd) || prefix.every((a) => a.assign && harmless(a.assign));
    seg(sc, "", [], ok ? null : "assignment", c);
    return sc.cwd;
  }
  for (const a of prefix) if (!(a.assign && harmless(a.assign))) c.reason = pick(c.reason, "assignment");
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
  seg(sc, prog, rest.map((a) => a.value ?? a.text), reason ?? bad?.reason ?? null, c, at);
  if (bad) Object.defineProperty(sc.run.out[sc.run.out.length - 1], "dynamicArgs", { value: rest.flatMap((a, i) => (a.value === null ? [i] : [])), enumerable: false });
  return cwd;
}

/** Parses `src` as a nested script (bash -c, eval, watch, flock -c) and walks it. */
function runString(label: string, src: string, c: Cmd, cwd: string | null): string | null {
  const sc: Scope = { ...c.sc, cwd, wrappers: [...c.sc.wrappers, label] };
  sc.run.strings.push(src);
  if (sc.depth + 1 > MAX_DEPTH) {
    seg(sc, label, [], "depth", c);
    withBodies(sc, opaqueBodies(src, false));
    return cwd;
  }
  let script: Script | undefined;
  try {
    script = parse(src);
  } catch {
    script = undefined;
  }
  if (!script || (script as any).errors?.length) {
    seg(sc, label, [src], "parse_error", c);
    return cwd;
  }
  walkScript(script, src, { ...sc, depth: sc.depth + 1, redirects: c.redirs, heredoc: c.heredoc, docs: c.docs, stdin: c.feeds, reason: c.reason });
  return cwd;
}

/** One command whose words are resolved: unwrap the wrappers, emit the segment of the program. */
function run(words: W[], c: Cmd, cwd: string | null): string | null {
  const sc = c.sc;
  const p = words[0];
  const rest = words.slice(1);
  if (p.value === null) {
    // `$V/bin/pip`: the program is named by the literal basename after the expansion; the name goes through the same lookup a literal program does, so the segment is not opaque for its program word
    const leaf = p.tail?.split(/[\\/]/).pop();
    if (leaf) {
      return run([{ text: p.text, value: leaf, reason: null }, ...rest], c, cwd);
    }
    seg(sc, p.text, rest.map((a) => a.value ?? a.text), p.reason ?? "unresolved_var", c, cwd);
    return cwd;
  }
  const prog = p.value;
  const name = baseName(prog);
  const wrap = (inner: W[], w: string, at = cwd, pass = false, clears: string[] = []): string | null => {
    if (!inner.length) return plain(prog, name, [], c, cwd);
    return run(inner, { ...c, sc: { ...sc, wrappers: [...sc.wrappers, w], passAt: pass ? [...(sc.passAt ?? []), sc.wrappers.length] : sc.passAt, cleared: clears.length ? [...(sc.cleared ?? []), ...clears] : sc.cleared } }, at);
  };
  const bad = (reason: OpaqueReason): string | null => {
    seg(sc, prog, rest.map((a) => a.value ?? a.text), reason, c, cwd);
    return cwd;
  };
  const opts = (spec: OptSpec) => parseOpts(rest, spec);
  const strOf = (list: W[]): string | null => (list.every((a) => a.value !== null) ? list.map((a) => a.value).join(" ") : null);
  if (FOREIGN.has(name) || FOREIGN_FILE.test(prog)) return plain(prog, name, rest, c, cwd);

  switch (name) {
    case "cd":
    case "pushd": {
      plain(prog, name, rest, c, cwd);
      // `pushd` with an option moves nothing we track; `popd` is not tracked at all
      const one = rest.length === 1 && rest[0].value !== null && !(name === "pushd" && /^[-+]/.test(rest[0].value)) ? rest[0].value : null;
      return one === null ? null : (cdTarget(["cd", one], cwd ?? undefined, win32(sc.run)) ?? null);
    }
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
      const clears = o.opts.filter((x) => x.name === "-u" || x.name === "--unset").map((x) => x.value ?? "");
      if (has(o.opts, "-i", "--ignore-environment") || args[0]?.value === "-") clears.push("*");
      if (args[0]?.value === "-") args = args.slice(1);
      let at = cwd;
      const dir = val(o.opts, "-C", "--chdir");
      if (dir !== null) at = cdTarget(["cd", dir], cwd ?? undefined, win32(sc.run)) ?? null;
      while (args.length && (args[0].assign ?? asAssign(args[0]))) {
        if (!harmless((args[0].assign ?? asAssign(args[0]))!)) c.reason = pick(c.reason, "assignment");
        args = args.slice(1);
      }
      wrap(args, "env", at, true, clears);
      return cwd;
    }
    case "timeout": {
      const o = opts({ flags: "v", arg: "ks", long: ["--foreground", "--preserve-status", "--verbose"], longArg: ["--kill-after", "--signal"] });
      if (typeof o === "string") return bad(o);
      if (o.rest[0] && o.rest[0].value === null) return bad(o.rest[0].reason ?? "unresolved_var");
      return wrap(o.rest.slice(1), "timeout", undefined, true);
    }
    case "nice": {
      const o = opts({ arg: "n", numeric: true, longArg: ["--adjustment"] });
      return typeof o === "string" ? bad(o) : wrap(o.rest, "nice", undefined, true);
    }
    case "nohup": {
      const o = opts({});
      if (typeof o === "string") return bad(o);
      if (!c.redirs.some((r) => [">", ">>", "&>", "&>>"].includes(r.op) && (r.fd === null || r.fd === "1"))) c.reason = pick(c.reason, "writing_wrapper");
      return wrap(o.rest, "nohup", undefined, true);
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
      return wrap(o.rest, "command", undefined, true);
    }
    case "exec": {
      // `exec [-cl] [-a name] cmd args`: the command is the segment; the redirect-only form (no command) stays the opaque builtin
      const o = opts({ flags: "cl", arg: "a" });
      if (typeof o === "string" || !o.rest.length) return bad("shell_builtin");
      // a failed `exec cd` (execfail) leaves the shell where it was: the inner command's cwd is not taken over, as for `env`
      wrap(o.rest, "exec", cwd, false, has(o.opts, "-c") ? ["*"] : []);
      return cwd;
    }
    case "stdbuf": {
      const o = opts({ arg: "ioe", longArg: ["--input", "--output", "--error"] });
      return typeof o === "string" ? bad(o) : wrap(o.rest, "stdbuf", undefined, true);
    }
    case "setsid": {
      const o = opts({ flags: "cfw", long: ["--ctty", "--fork", "--wait"] });
      return typeof o === "string" ? bad(o) : wrap(o.rest, "setsid", undefined, true);
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

/** A pass-through wrapper whose words name a runner (`env sh`, `nohup bash`): the wrapped command runs text. */
const wrapsRunner = (x: any): boolean => (x.suffix ?? []).some((w: any) => typeof (w.value ?? w.text) === "string" && (RUNNERS.has(baseName(w.value ?? w.text)) || /[$`]/.test(w.text ?? "")));

/** The line holds a function definition, or a command that runs code or text (`eval`, `source`, `.`, a runner, a computed program name). `passing`: wrappers the walker unwrapped as pass-through (see `passNames`) do not count unless they wrap a runner (the constants `$FOREMAN_SCRATCH` and `$FOREMAN_OUT` only). */
function runsCode(node: SyntaxNode, passing: ReadonlySet<string> = new Set()): boolean {
  let found = false;
  const visit = (n: SyntaxNode): void => {
    if (found) return;
    const x = n as any;
    if (x.type === "Function") found = true;
    else if (x.type === "Command" && x.name && (/[$`]/.test(x.name.text) || (RUNNERS.has(baseName(x.name.value ?? x.name.text)) && !(passing.has(baseName(x.name.value ?? x.name.text)) && !wrapsRunner(x))))) found = true;
    else forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** The names of the wrappers the walker unwraps as pass-through in `script`: a trial walk, read off the `passThrough` field of its segments. */
function passNames(script: Script, src: string, sc: Scope): Set<string> {
  const rn = sc.run;
  const trial: Run = { out: [], vars: new Map(), assignOk: new Set(), env: rn.env, platform: rn.platform, strings: [], trial: true };
  walkScript(script, src, { ...sc, run: trial });
  return new Set(trial.out.flatMap((x) => (x.passThrough ?? []).map((i) => x.wrappers[i])));
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
const onlyExpanded = (text: string, name: string): boolean => [...text.matchAll(new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, "g"))].every((m) => (text[m.index! - 1] === "$" || (text.slice(m.index! - 2, m.index!) === "${" && text[m.index! + name.length] === "}")));

/**
 * True when a word of `line` names the variable `name` other than as a `$NAME` / `${NAME}` expansion, read from the parser's decoded word values (quotes and escapes removed, an
 * expansion left as a NUL): `printf -v FOREMAN_OU'T'`, `FOREMAN_OU\T=x`, `read FOREMAN_"OUT"`, also inside a nested `sh -c '...'` string. True too when the line does not parse.
 */
export function namedOutsideExpansion(line: string, name: string): boolean {
  const words: string[] = [];
  const walk = (n: any, depth: number): void => {
    if (!n || typeof n !== "object" || depth > 200) return;
    if (n.type === "Assignment") words.push(String(n.name));
    if (n.type === "Word") {
      const lit = (p: any): string => (p.type === "Literal" || p.type === "SingleQuoted" || p.type === "AnsiCQuoted" ? String(p.value) : p.type === "DoubleQuoted" || p.type === "LocaleString" ? p.parts.map(lit).join("") : "\0");
      words.push(n.parts ? n.parts.map(lit).join("") : String(n.value));
    }
    // the library's own traversal: Assignment name/value, Word parts, expansion scripts and the like are prototype getters that `Object.values` never reads
    forEachChild(n, (c) => walk(c, depth + 1));
  };
  try {
    const s = parse(line) as any;
    if (!s || s.errors?.length) return true;
    walk(s, 0);
  } catch {
    return true;
  }
  return !words.every((t) => onlyExpanded(t, name));
}

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
  // an env-clearing wrapper in front of a nested `-c` string: the inner shell sees the harness names empty
  const gone = (name: string): boolean => !!sc.cleared && (sc.cleared.includes("*") || sc.cleared.includes(name));
  for (const n of ["FOREMAN_SCRATCH", "FOREMAN_OUT"]) if (gone(n)) delete env[n];
  if (sc.cwd) env.PWD = sc.cwd;
  const res = resolveVars(pipes, [], env, () => false, src, rn.platform);
  const child = childAssigns(script, src, rn);
  for (const [, , cmd] of child.values()) rn.assignOk.add(cmd);
  // the harness constants `$FOREMAN_SCRATCH` and `$FOREMAN_OUT` of a child resolve on any line that never rebinds them (a heredoc or pipe leaves the closed grammar)
  const runs = rn.trial || !(rn.env.FOREMAN_SCRATCH || rn.env.FOREMAN_OUT) ? true : runsCode(script, passNames(script, src, sc));
  // the mention rule reads the whole line, not the nested string being walked: `env FOREMAN_OUT=/x sh -c 'echo > $FOREMAN_OUT/f'` rebinds it
  const whole = rn.root ?? src;
  const harnessConst = (name: string): boolean => !!env[name] && !runs && onlyExpanded(whole, name) && ![whole, src, ...rn.strings].some((t) => namedOutsideExpansion(t, name));
  const scratchConst = harnessConst("FOREMAN_SCRATCH");
  const outConst = harnessConst("FOREMAN_OUT");
  sc.consts = [...(scratchConst ? ["FOREMAN_SCRATCH"] : []), ...(outConst ? ["FOREMAN_OUT"] : [])];
  for (const pr of probes) {
    const got = res.get(pr.unit);
    const later = (n: string): string | undefined => {
      if (n === "FOREMAN_SCRATCH" && scratchConst) return rn.env.FOREMAN_SCRATCH;
      if (n === "FOREMAN_OUT" && outConst) return rn.env.FOREMAN_OUT;
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
  sc.src = src;
  prepare(script, src, sc);
  walkList(script.commands, sc);
}

/**
 * The here-document bodies the parser reads in `command`, as source offsets from the start of the body to the end of the closing line, or null when `command` does
 * not parse (a quote left open, a `<<` inside it, is none). A here-document inside a word (`$(...)`, backticks) or a function body is not listed, and nor is one
 * the parser reports without a closing line. The third element is true when a shell does not expand the body: the tag has a quoted part (the parser's `quoted`)
 * and its source text (the delimiter word's slice of `command`) holds no `$'` or `$"`, which dash does not read as a quote (it ends such a heredoc at a line `$EOF`,
 * earlier than the parser). An unquoted body is never data, whatever it holds.
 */
export function heredocSpans(command: string): Array<[number, number, boolean]> | null {
  let script: Script | undefined;
  try {
    script = parse(command);
  } catch {
    return null;
  }
  if (!script || (script as any).errors?.length) return null;
  const spans: Array<[number, number, boolean]> = [];
  const visit = (n: SyntaxNode, depth: number): void => {
    const x = n as any;
    if (depth > 200 || x.type === "Word" || x.type === "Function") return;
    if (x.type === "HereDoc") {
      if (x.closing) spans.push([x.body.pos, x.closing.end, !!x.delimiter?.quoted && !/\$['"]/.test(command.slice(x.delimiter.pos, x.delimiter.end))]);
      return;
    }
    forEachChild(n, (c) => visit(c, depth + 1));
  };
  visit(script as SyntaxNode, 0);
  return spans;
}

/** `command` with every here-document body blanked (spaces, newlines kept; same length), from the parser's body positions; a text that does not parse is returned as it is. */
export function blankHeredocBodies(command: string): string {
  try {
    const script = parse(command) as Script;
    if (!script || script.errors?.length) return command;
    let out = command;
    const visit = (n: SyntaxNode): void => {
      const x = n as any;
      if (x.type === "HereDoc") {
        const body = command.slice(x.body.pos, x.body.end).replace(/[^\n]/g, " ");
        out = out.slice(0, x.body.pos) + body + out.slice(x.body.end);
      }
      forEachChild(n, visit);
    };
    visit(script as SyntaxNode);
    return out;
  } catch {
    return command;
  }
}

/**
 * `command` with its comments blanked (each `#` to the end of its line replaced by spaces; same length), read from the parser's node positions. Every token node is
 * covered: each word (also the words of compound commands: for/select names and lists, case words and patterns, function and coproc names; a substitution is part of its
 * word), assignment, redirect, here-string, here-document with its body and closing line, `[[ ]]` and `(( ))` command and the header of an arithmetic for. What lies
 * outside every token is keywords, operators, whitespace and comments (unbash has no comment nodes); the parser opens a comment only at a word boundary, so a `#` there
 * is always a comment, and the blanking stops at the end of its line. A text that does not parse is returned as it is.
 */
export function blankComments(command: string): string {
  try {
    const script = parse(command) as Script;
    if (!script || script.errors?.length) return command;
    const spans: Array<[number, number]> = [];
    const eol = (i: number): number => {
      const j = command.indexOf("\n", i);
      return j < 0 ? command.length : j;
    };
    const visit = (n: SyntaxNode): void => {
      const x = n as any;
      switch (x.type) {
        case "Word":
        case "Assignment":
        case "Redirect":
        case "HereString":
        case "TestCommand":
        case "ArithmeticCommand":
          spans.push([x.pos, x.end]);
          return;
        case "HereDoc":
          spans.push([x.pos, x.end], [x.body.pos, x.body.end]);
          if (x.closing) spans.push([x.closing.pos, eol(x.closing.end)]);
          return;
        case "ArithmeticFor":
          spans.push([x.pos, x.body.pos]);
          visit(x.body);
          return;
      }
      forEachChild(n, visit);
    };
    visit(script as SyntaxNode);
    spans.sort((a, b) => a[0] - b[0]);
    const gaps: Array<[number, number]> = [];
    let at = 0;
    for (const [a, b] of spans) {
      if (a > at) gaps.push([at, a]);
      at = Math.max(at, b);
    }
    if (at < command.length) gaps.push([at, command.length]);
    let out = command;
    for (const [a, b] of gaps) {
      let i = a;
      while (i < b) {
        const h = command.indexOf("#", i);
        if (h < 0 || h >= b) break;
        const e = Math.min(eol(h), b);
        out = out.slice(0, h) + " ".repeat(e - h) + out.slice(e);
        i = Math.max(e, h + 1);
      }
    }
    return out;
  } catch {
    return command;
  }
}

/**
 * Parses `command` into segments (see the header). A parse error is one opaque `parse_error` segment; an empty line has none.
 * Any RangeError (a stack overflow while parsing or walking a line too deep for the stack is the case that occurs) is the same:
 * one `parse_error` segment, none of the partial ones. Any other error propagates.
 */
export function parseShell(command: string, opts: ShellParseOptions = {}): ShellSegment[] {
  const start = (): Scope => {
    const run: Run = { out: [], vars: new Map(), assignOk: new Set(), env: opts.env ?? {}, platform: opts.platform ?? process.platform, strings: [], root: command };
    return { run, cwd: opts.cwd ?? null, wrappers: [], depth: 0, stdin: false, redirects: [], heredoc: false, docs: [], reason: null };
  };
  const unreadable = (): ShellSegment[] => {
    const sc = start();
    seg(sc, "", [], "parse_error");
    return sc.run.out;
  };
  const sc = start();
  let script: Script | undefined;
  try {
    script = parse(command);
  } catch {
    script = undefined;
  }
  if (!script || (script as any).errors?.length) return unreadable();
  try {
    walkScript(script, command, sc);
  } catch (e) {
    if (e instanceof RangeError) return unreadable();
    throw e;
  }
  Object.defineProperty(sc.run.out, "strings", { value: sc.run.strings, enumerable: false });
  return sc.run.out;
}

/**
 * The text before the statement that holds the first parse error of `cmd`, cut by the parser's own offsets: the statements that end at or before the error position
 * and are not empty. Null when `cmd` parses, throws, or no statement precedes the error.
 */
export function beforeParseError(cmd: string): string | null {
  let script: Script | undefined;
  try {
    script = parse(cmd);
  } catch {
    return null;
  }
  const err = (script as any)?.errors?.[0] as { pos: number } | undefined;
  if (!script || !err) return null;
  let cut = 0;
  for (const st of script.commands) if (st.end > st.pos && st.end <= err.pos) cut = Math.max(cut, st.end);
  return cut > 0 ? cmd.slice(0, cut) : null;
}

const BODY_NODES = new Set(["Function", "Select", "Coproc", "ArithmeticFor"]);

function ownBody(n: SyntaxNode, cmd: string): string | null {
  const b = BODY_NODES.has(n.type) ? (n as { body?: { pos: number; end: number; type: string } }).body : undefined;
  // a select or arithmetic for body ends before its heredocs: the slice runs to the end of the node, less the closing `done` or `}`
  if (b && typeof b === "object" && b.type !== "Word") return n.type === "Select" || n.type === "ArithmeticFor" ? cmd.slice(b.pos, n.end).replace(/[\s;]*(?:\bdone|\})\s*$/, "") : cmd.slice(b.pos, b.end);
  return null;
}

/** The body text of one function, select, coproc or arithmetic for node (none for any other node). */
function nodeBodies(n: SyntaxNode, cmd: string): string[] {
  const b = ownBody(n, cmd);
  return b === null ? [] : [b];
}

/** The source text of the body of every function, select, coproc and arithmetic for in `cmd` (outermost only) that parses as a script. */
export function opaqueBodies(cmd: string, intoStrings = false): string[] {
  const out: string[] = [];
  const walk = (n: SyntaxNode): void => {
    const b = ownBody(n, cmd);
    if (b !== null) out.push(b);
    else forEachChild(n, walk);
  };
  walk(parse(cmd));
  // the strings run as scripts hold function bodies of their own (the floors read them as the old check read a string): the parser names them, as it resolves the shell
  // behind env, nice, timeout, command, nohup, a path and the like, so every spelling that reaches a shell string is read the same
  if (intoStrings) {
    const strings = (parseShell(cmd) as ShellSegment[] & { strings?: string[] }).strings ?? [];
    for (const str of strings) out.push(...opaqueBodies(str, false));
  }
  return out;
}

/** The names a line binds: `names` are the assigned ones, `any` is set when a construct may bind any name (`read`, `for`, `eval`, a parse failure ...). */
export interface BoundNames {
  names: Set<string>;
  any: boolean;
}

/** Builtins that bind a name given as a plain word, or run text that may bind any (`read N`, `printf -v N`, `eval`, `source`, `.`). */
const BINDS_ANY = new Set(["read", "mapfile", "readarray", "getopts", "let", "eval", "source", ".", "trap"]);
/** Prefix assignments that make a shell run a file (`BASH_ENV=./f bash -c ..`). */
const RUNS_FILE_VARS = new Set(["BASH_ENV", "ENV"]);
const CLEAN_ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;
/** Wrappers a builtin hides behind (`command read N`). */
const BUILTIN_WRAPPERS = new Set(["command", "builtin", "time"]);
const ARITH_ASSIGN = /^(?:\*\*|<<|>>|[-+*/%&|^])?=$/;
/** Variables bash evaluates an assigned value of as arithmetic, like a `declare -i` name. */
const INT_SPECIALS = ["OPTIND", "OPTERR", "SECONDS", "RANDOM", "LINENO", "HISTCMD"];
const DECIMAL = /^[0-9]+$/;
const ARITH_TEST_OPS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);

/**
 * The variable names `command` may bind, from its own parse (round 2, step 1): `N=`, `N+=`, `N[..]=` (also after export / declare / local / readonly /
 * typeset, which also bind a bare `N`), `unset N`, `${N=..}` / `${N:=..}`, an assigning arithmetic. `any` for `read` / `mapfile` / `readarray` / `getopts` / `let`,
 * `for`, `printf -v`, `declare -n`, `eval`, `source`, `.`, and a line that does not parse.
 */
export function boundNames(command: string): BoundNames {
  const out: BoundNames = { names: new Set(), any: false };
  let script: Script | undefined;
  try {
    script = parse(command);
  } catch {
    script = undefined;
  }
  if (!script || (script as any).errors?.length) return { names: out.names, any: true };
  // Arithmetic contexts: bash evaluates the text of an expansion there (`y='S=1'; (( $y ))` assigns S). `late` holds the checks that need the whole
  // line first: `tainted` names were assigned a non-decimal value, `ints` names evaluate an assigned value as arithmetic.
  const ints = new Set(INT_SPECIALS);
  const tainted = new Set<string>();
  const late: Array<() => boolean> = [];
  const nonDecimal = (w: any): boolean => w != null && !DECIMAL.test(String(w.value ?? w.text ?? ""));
  /** `strict`: any name or expansion is risky; else only an expansion or name assigned a non-decimal value, and any positional or computed one. */
  const arith = (text: string, strict: boolean): boolean => {
    if (/\$(?!\{?[A-Za-z_])|`/.test(text)) return true;
    // an assignment, `++` or `--` anywhere in an arithmetic text (`a[HOME=1]=1`, `$((x=y))`) may bind any name
    if (/=|\+\+|--/.test(text.replace(/[=!<>]=/g, ""))) return true;
    const ids = text.match(/(?<![A-Za-z0-9_])[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    return strict ? ids.length > 0 : ids.some((i) => tainted.has(i));
  };
  const wordText = (w: any): string => String(w?.value ?? w?.text ?? "");
  /** Names the line assigns (not the plain argument names), and the names an argument expands (`wait -p $x`): one that is assigned may hold any name. */
  const assigned = new Set<string>();
  const expanded = new Set<string>();
  const bind = (n: string): void => {
    out.names.add(n);
    assigned.add(n);
  };
  /** A word with a `[..]` subscript after a name character whose inner text is not a plain decimal: `test -v` and `declare` evaluate it as arithmetic. */
  const subscriptRisky = (text: string): boolean => {
    const open = text.search(/[A-Za-z0-9_]\[/) + 1;
    if (open < 1) return false;
    const close = text.lastIndexOf("]");
    const inner = text.slice(open + 1, close > open ? close : undefined);
    return arith(inner, true);
  };
  /**
   * An argument word read raw (text inside single quotes is no expansion): a positional or computed expansion, a command substitution or an unquoted brace expansion
   * (`{a,b}`, `{1..3}`) answers any now; a named one (`$x`, `${x:-..}`, `${!x}`) when the line assigns that name, or when it is joined to a literal that is itself
   * a name (`$unset'HOME'`). `${n:=..}` itself and `$((..))` are read elsewhere.
   */
  const expands = (raw: string): boolean => {
    let live = "";
    let unquoted = "";
    let plain = "";
    let dq = false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c === "\\") {
        i++;
        plain += raw[i] ?? "";
        live += "\u0001x\u0001";
        unquoted += "x";
      } else if (c === "'" && !dq) {
        const ansi = live.endsWith("$");
        if (ansi) live = live.slice(0, -1);
        for (i++; i < raw.length && raw[i] !== "'"; i++) {
          if (ansi && raw[i] === "\\") i++;
          plain += raw[i] ?? "";
        }
        live += "\u0001x\u0001";
        unquoted += "x";
      } else if (c === '"') {
        dq = !dq;
        live += "\u0001";
      } else {
        live += c;
        plain += c;
        unquoted += dq ? "x" : c;
      }
    }
    if (/(?<!\$)\{[^{}]*(?:,|\.\.)/.test(unquoted)) return true;
    const text = live.replace(/\$\(\(.*?\)\)/gs, " ");
    let found = false;
    for (const m of text.matchAll(/\$\{[^}]*\/|\$!|\$\{!([A-Za-z_][A-Za-z0-9_]*)|\$\{?([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_]|:?=)|\$\{?(?=\d|[@*])|\$\((?!\()|`/g)) {
      const n = m[1] ?? m[2];
      if (n === undefined) return true;
      expanded.add(n);
      found = true;
    }
    // `wait -p ${x:-HOME}`: the default is the name bound when x is unset
    for (const m of plain.matchAll(/\$\{[^}]*?[-+=?]([A-Za-z_][A-Za-z0-9_]*)\}/g)) out.names.add(m[1]);
    return found && /^\u0001*(?:-[A-Za-z]+)?\u0001*\w[\w\u0001]*$/.test(text.replace(/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, ""));
  };
  const visit = (n: SyntaxNode, depth: number): void => {
    const x = n as any;
    switch (x.type) {
      case "Command": {
        const assigns = [...x.prefix, ...x.suffix].filter((a: any) => a.type === "Assignment");
        for (const a of assigns) {
          bind(a.name);
          if (RUNS_FILE_VARS.has(a.name)) out.any = true;
          const vals: any[] = a.value?.type === "ArrayValue" ? a.value.elements : a.value ? [a.value] : [];
          // `[key]=v` of a compound array: the key is an arithmetic subscript, the value is what is assigned
          const plain = vals.map((v) => (/^\[.*\]=/s.test(wordText(v)) ? { value: wordText(v).replace(/^\[.*?\]=/s, "") } : v));
          for (const v of vals) {
            const key = /^\[(.*?)\]=/s.exec(wordText(v));
            if (key) late.push(() => arith(key[1], false));
          }
          if (plain.some(nonDecimal)) tainted.add(a.name);
          late.push(() => ints.has(a.name) && plain.some(nonDecimal));
          if (a.index) late.push(() => arith(wordText(a.index), false));
        }
        // a computed program name (`$x ./f`) or a quote-broken assignment word (`HO""ME=/x`, `{HOME,X}=/x`)
        if (x.name && (/[$`]/.test(x.name.text) || (String(x.name.value).includes("=") && !CLEAN_ASSIGN.test(String(x.name.value))))) out.any = true;
        const clean = CLEAN_ASSIGN.exec(String(x.name?.value ?? ""));
        if (clean) bind(clean[1]);
        const words: string[] = [];
        const raws: string[] = [];
        for (const w of [x.name, ...x.suffix])
          if (w && w.type === "Word") {
            words.push(String(w.value ?? w.text));
            raws.push(String(w.text ?? w.value));
          }
        while (words.length && BUILTIN_WRAPPERS.has(baseName(words[0]))) {
          words.shift();
          raws.shift();
        }
        const name = words.length ? baseName(words[0]) : "";
        const args = words.slice(1);
        if (name === "env") {
          for (let i = 0; i < args.length; i++) {
            const a = args[i];
            const m = CLEAN_ASSIGN.exec(a);
            if (m) bind(m[1]);
            else if (/^-[A-Za-z]*S|^--split-string/.test(a)) out.any = true;
            else if (/^(?:-[A-Za-z]*[uCP]|--unset|--chdir)$/.test(a)) i++;
            else if (!a.startsWith("-")) break;
          }
        }
        // fail closed: a plain argument that is a variable name may be bound by the command (`wait -p N`, `compgen -V N`); a subscript that assigns may bind any name
        // an option with its name attached (`wait -pHOME`) counts too: the tail after the leading letters
        args.forEach((a, i) => {
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) out.names.add(a);
          if (a.startsWith("-"))
            for (let k = 1; k < a.length; k++) {
              if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(a.slice(k))) out.names.add(a.slice(k));
              if (!/[A-Za-z]/.test(a[k])) break;
            }
          if (subscriptRisky(a) || expands(raws[i + 1])) out.any = true;
        });
        if (DECLARE.has(name) && args.some((a) => /^-[A-Za-z]*i/.test(a))) {
          for (const a of args) if (!a.startsWith("-")) ints.add(/^[A-Za-z_][A-Za-z0-9_]*/.exec(a)?.[0] ?? a);
          for (const a of assigns) ints.add(a.name);
        }
        if (BINDS_ANY.has(name)) out.any = true;
        else if (name === "printf" && args.some((a) => /^-[A-Za-z]*v/.test(a))) out.any = true;
        else if (DECLARE.has(name) || name === "unset") {
          if (args.some((a) => /^-[A-Za-z]*n/.test(a))) out.any = true;
          for (const a of args) {
            const m = CLEAN_ASSIGN.exec(a);
            if (m) bind(m[1]);
            else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) bind(a);
            else if (!a.startsWith("-") && !(/^[A-Za-z_][A-Za-z0-9_]*\[[^\]]*\]\+?=/.test(a))) out.any = true;
          }
        }
        // a nested script (`bash -c '..'`, `flock f -c '..'`, `watch '..'`): what it binds counts too
        // a `-c` anywhere among the leading flags (`bash -c -e '..'`) makes the next plain word the script
        {
          let sawC = /^-[A-Za-z]*c$/.test(String(x.name?.value ?? ""));
          x.suffix.forEach((w: any, i: number) => {
            const flag = i > 0 ? x.suffix[i - 1] : x.name;
            const isC = w.type === "Word" && /^-[A-Za-z]*c$/.test(String(w.value));
            const script = w.type === "Word" && w.value !== undefined && ((flag?.type === "Word" && /^-[A-Za-z]*c$/.test(String(flag.value))) || (sawC && !String(w.value).startsWith("-")));
            if (isC) sawC = true;
            if (script && depth >= MAX_DEPTH) out.any = true;
            else if (script) {
              let inner: Script | undefined;
              try {
                inner = parse(String(w.value));
              } catch {
                inner = undefined;
              }
              if (!inner || (inner as any).errors?.length) out.any = true;
              else for (const st of inner.commands) visit(st, depth + 1);
            }
          });
        }
        break;
      }
      case "For":
      case "ArithmeticFor":
      case "Select":
      case "Coproc":
        out.any = true;
        break;
      case "ArithmeticExpansion":
        late.push(() => arith(String(x.text ?? "").replace(/^\$(?:\(\(|\[)/, "").replace(/(?:\)\)|\])$/, ""), false));
        break;
      case "TestUnary":
        if (subscriptRisky(wordText(x.operand)) || expands(String(x.operand?.text ?? wordText(x.operand)))) out.any = true;
        break;
      case "TestBinary":
        if (ARITH_TEST_OPS.has(x.operator)) for (const w of [x.left, x.right]) late.push(() => arith(wordText(w), false));
        break;
      case "ArithmeticCommand":
        // `(( 1 + 2 ))` binds nothing; a name or an expansion in it may evaluate to an assignment
        if (/[^\s\d+\-*/%()<>=!&|^~?:,]/.test(String(x.body ?? ""))) out.any = true;
        break;
      case "FileDescriptorVariable":
        bind(String(x.name));
        break;
      case "ParameterExpansion": {
        const op = x.operation;
        if (x.parameter && (op?.operator === "=" || op?.operator === ":=")) {
          if (x.prefix === "!") out.any = true;
          else bind(x.parameter);
          // `wait -p ${a:=HOME}`: the value is the name the command binds
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(wordText(op.operand))) out.names.add(wordText(op.operand));
          if (nonDecimal(op.operand)) tainted.add(x.parameter);
        }
        // a default / assign operand on an integer name and a `${a:off:len}` slice are evaluated as arithmetic, a subscript too
        if (op?.type === "Default" && x.parameter) late.push(() => ints.has(x.parameter) && nonDecimal(op.operand));
        if (op?.type === "Slice") for (const w of [op.offset, op.length]) if (w) late.push(() => arith(wordText(w), true));
        if (x.index) late.push(() => arith(wordText(x.index), false));
        // `${x@P}` runs the prompt expansion, `${a[S++]}` assigns in its subscript
        if ((op?.type === "Transform" && op.operand?.value === "P") || /[=]|\+\+|--/.test(String(x.index?.value ?? ""))) out.any = true;
        break;
      }
      case "ArithmeticBinary":
        if (ARITH_ASSIGN.test(x.operator)) {
          if (x.left?.type === "ArithmeticWord" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(x.left.value))) bind(String(x.left.value));
          else out.any = true;
        }
        break;
      case "ArithmeticUnary":
        if (x.operator === "++" || x.operator === "--") out.any = true;
        break;
    }
    forEachChild(n, (c) => visit(c, depth));
  };
  try {
    for (const st of script.commands) visit(st, 0);
    if (late.some((f) => f()) || [...expanded].some((n) => assigned.has(n))) out.any = true;
  } catch (e) {
    // a line too deep for the stack: unreadable, like parseShell's `parse_error`
    if (!(e instanceof RangeError)) throw e;
    out.any = true;
  }
  return out;
}
