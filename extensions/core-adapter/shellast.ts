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

import * as path from "node:path";
import { forEachChild, parse } from "unbash";
import type { Assignment, Command, CommandNode, CompoundList, ParsedScript as Script, Redirection, Statement, SyntaxNode, Word } from "unbash";
import { READ_PROGS, RUNNERS, effectsNames } from "./effects.ts";
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
  /**
   * Set (always true or false, not enumerable; a copy made with `{ ...seg }` loses it, so `carryFacts` hands it on): the walk emitted this segment without stating the program that runs, or the run unit
   * holds arithmetic or a subscript on a value not shown to be a number. Such a segment is never known-safe: it goes to the judge (defaults.ts `danger-unknown-program`).
   */
  programUnknown?: boolean;
  /** Set (not enumerable, handed on by `carryFacts`): the harness folder names (`FOREMAN_SCRATCH`, `FOREMAN_OUT`) the line may have rebound before or during this segment's run unit; a write through one is a write to an unknown place. */
  harnessRebound?: string[];
  /**
   * Set (not enumerable, handed on by `carryFacts`) on a segment whose program no table models (`modelled`): for each literal word after it, the words from there on read as a command of their own
   * (`caffeinate rm -rf x` runs `rm -rf x`), with the text they were cut from. The segments are a trial walk's, never in the line's own list. Read only by the judge-first list (defaults.ts `danger-unknown-program`).
   */
  behind?: Array<{ text: string; segments: ShellSegment[] }>;
  /**
   * Set (true only; not enumerable, handed on by `carryFacts`) on a segment the walk emitted inside a function body it walked at a call: a copy of what the body's own text reads as. The floors read the
   * body text once (as before) and spend their per-line budget on these copies alone.
   */
  walked?: boolean;
}

/** Hands the non-enumerable facts of `from` on to `copy` (a `{ ...seg }` copy drops them). */
export function carryFacts<S extends object>(copy: S, from: ShellSegment): S {
  if (from.programUnknown !== undefined) Object.defineProperty(copy, "programUnknown", { value: from.programUnknown, enumerable: false, configurable: true, writable: true });
  if (from.harnessRebound !== undefined) Object.defineProperty(copy, "harnessRebound", { value: from.harnessRebound, enumerable: false, configurable: true, writable: true });
  if (from.walked) Object.defineProperty(copy, "walked", { value: true, enumerable: false, configurable: true, writable: true });
  if (from.behind !== undefined) Object.defineProperty(copy, "behind", { value: from.behind, enumerable: false, configurable: true, writable: true });
  return copy;
}

export interface ShellParseOptions {
  /** The directory the line starts in (`$PWD` for the variable grammar). */
  cwd?: string | null;
  /** The harness env the variable grammar reads (`FOREMAN_SCRATCH`, `FOREMAN_OUT`). */
  env?: Record<string, string>;
  /** Harness names an enclosing line may have rebound (`ShellSegment.harnessRebound` of the segment this text was cut from): every segment starts with them. */
  rebound?: string[];
  /** Defaults to process.platform; "win32" switches on the drive-path forms of shellvars.ts. */
  platform?: string;
  /** A function body the caller reads again for itself (the text of a body, which its own segment already carries): a call of a function the text defines is not walked, so the text reads as it did before the walk existed. */
  noCalls?: boolean;
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
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const HARNESS_NAMES = ["FOREMAN_SCRATCH", "FOREMAN_OUT"];
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
  /** The line's run units (`unitNodes`), by node: the index of the unit a node starts. Set by `prepare` for the line's own script. */
  unitOf?: Map<object, number>;
  /** Per run unit: the harness names the line may have rebound by then (`harnessRebound`), and the names the caller handed in. */
  rebound?: string[][];
  seed?: string[];
  /** The run units holding arithmetic or a subscript not shown to be a number (`BoundDetail.unsafe`). */
  unsafe?: Set<number>;
  /** A look-behind walk (`lookBehind`): no look-behind of its own starts inside it. */
  behind?: boolean;
  /** The look-behind walk starts a program the line names (`npx`, `find -exec`), not an operand of an unknown one: a relative program word is judged in it too. */
  behindRuns?: boolean;
  /** The folder flow of the walk, in walk order (see `Flow`). Set for the line's own walk; a trial copy of the run gets a copy of it. */
  flow?: Flow;
  /** The function bodies the line defines (`collectFuncs`), by name: a call walks each of them where it stands (`run`). Set for the line's own walk only. */
  funcs?: Map<string, string[]>;
  /** The work done so far, shared by every trial copy of the run: body walks (`MAX_BODY_WALKS`), commands walked inside bodies (`MAX_BODY_CMDS`), look-behind starts (`BEHIND_BUDGET`). */
  budget?: { walks: number; cmds: number; starts: number };
  /** The segments of a command whose program names a function of `funcs` at the time it was walked; any other segment with such a program is marked unknown after the walk. */
  resolved?: Set<ShellSegment>;
}

/**
 * Whether the shell may be in a folder the walk cannot name because a `cd` or `pushd` took a target it cannot read (a variable, a substitution): `dyn`. It is kept while the folder stays unknown
 * and cleared only by a `cd` to a literal absolute path that runs unconditionally (`cond` counts the conditional constructs around the walk: an `||` operand, a branch, a loop, an `eval` or function body).
 * `any`: some `cd` or `pushd` of the line used such a target, so `popd`, `cd -` and a `pushd` without a literal target may land there too.
 */
interface Flow {
  dyn: boolean;
  any: boolean;
  cond: number;
}

/** Runs `fn` where a `cd` in it does not leave it (a subshell, a substitution, a pipeline stage, a background job, a `bash -c` string); the flow state comes back as it was. */
function isolated<T>(rn: Run, fn: () => T): T {
  const fl = rn.flow;
  if (!fl) return fn();
  const saved = { dyn: fl.dyn, cond: fl.cond };
  fl.cond = 0;
  try {
    return fn();
  } finally {
    fl.dyn = saved.dyn;
    fl.cond = saved.cond;
  }
}

/** Runs `fn` where it may not run (a branch, a loop, an `||` operand, an `eval` or function body): a `cd` in it never clears the flow state, one that sets it stays set. */
function conditional<T>(rn: Run, fn: () => T): T {
  const fl = rn.flow;
  if (!fl) return fn();
  fl.cond++;
  try {
    return fn();
  } finally {
    fl.cond--;
  }
}

interface Scope {
  run: Run;
  cwd: string | null;
  wrappers: string[];
  /** Indexes into `wrappers` of the pass-through wrappers (see `ShellSegment.passThrough`). */
  passAt?: number[];
  /** Names an env-clearing wrapper (`env -i`, `env -`, `env -u NAME`, `exec -c`) took out of the environment of what it runs; `*` is every name. A nested `-c` string under it sees them empty. */
  cleared?: string[];
  /** `cleared` as it stood where a nested `-c` string began: only that string's own shell expands the names itself, so they count as rebound there (`reboundAt`). */
  wiped?: string[];
  /** The harness constants the script being walked reads as constants (set by `prepare`). */
  consts?: string[];
  depth: number;
  /** The commands walked here sit inside a select body: the body is also kept as a text (`bodies`) that the floors read again one level deeper, so the bodies of what stands in it are left to that read. */
  inSelect?: boolean;
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
  /** The run unit of the line the commands walked here belong to (see `unitNodes`). */
  unit?: number;
  /** Inside an `xargs`: the replace string of `-I` / `-i` / `-J` / `--replace` (the input is put in its place), set for the wrapped command and what it runs. */
  replace?: string;
  /** The functions whose bodies are being walked, outermost first: a call of one of them is the recursion already being walked. */
  fnStack?: string[];
  /** Directly inside an `xargs`: the input may supply the program or the script where the words give none (cleared in a nested `-c` string). */
  xargs?: boolean;
  /** The script being walked runs in a shell that reads startup files (`bash -l -c`, `sh -i -c`): they may rebind any name before it. */
  startup?: boolean;
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
  /** Whether the part of the word after its last `/` (the whole word without one) has no expansion, glob or brace in it: such a word names its program by that part (`~/bin/tool`). */
  lit?: boolean;
  /** The word as the shell runs it (unquoted, unescaped) where an expansion left it opaque; names a tilde program in its segment. */
  decoded?: string;
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
  // a glob, a substitution or another computed part: the word names no program by its tail (`$(npm root -g)/git` stays a computed command word)
  let computed = false;
  const brk = (r: OpaqueReason, comp = false): void => {
    note(r);
    tail = "";
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
  else {
    // a word the parser gives no parts (a tilde word): its text is the literal, so `~/../../usr/bin/env` names `env` by its last component
    out = w.value;
    tail = w.value;
  }
  return { text: w.text, value: reason ? null : out, reason, ...(reason && !computed && /[\\/]/.test(tail) ? { tail } : {}), ...(reason ? { lit: lastComponentLiteral(w), decoded: out } : {}) };
}

/**
 * Whether the part of `w` after its last literal `/` (the whole word when it has none) is plain text: no expansion, quoted expansion, substitution, glob or brace in it. Read from the
 * parser's word parts. `$V/bin/pip` and `~/bin/tool` are plain, `$E`, `"$E"`, `${E}h`, `$V/bin/s$X` and `{rm,-rf}`, `$'sh'` and `$"sh"` (parts `wordOf` does not decode) are not.
 */
function lastComponentLiteral(w: Word): boolean {
  let lit = true;
  const go = (parts: readonly any[]): void => {
    for (const p of parts) {
      if (p.type === "DoubleQuoted") go(p.parts);
      else if (p.type === "Literal" || p.type === "SingleQuoted") {
        if (String(p.value).includes("/")) lit = true;
      } else lit = false;
    }
  };
  if (w.parts) go(w.parts);
  return lit;
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

/** Names a later command of the line reads as more than data: the search path, the shell's own variables, a loader, a tool's or the harness's settings. Case folded (zsh ties `path` to `PATH`). */
const STEERING = /^(PATH|IFS|HOME|SHELL|ENV|CDPATH|GLOBIGNORE|PS[0-9]|PROMPT_COMMAND|FCEDIT|EDITOR|VISUAL|TMPDIR|OLDPWD|PWD|SHLVL|OPTIND|OPTARG|POSIXLY_CORRECT|BASH_.*|BASHOPTS|SHELLOPTS|LD_.*|DYLD_.*|GIT_.*|NODE_.*|PYTHON.*|PERL.*|RUBY.*|FOREMAN_.*|PI_.*|MAIL.*|HIST.*|TERM.*|NPM_.*|XDG_.*|USER|LOGNAME|LANG|LC_.*)$/i;

/** Names whose setting makes a shell or loader run code the line does not show (a prompt, a startup file, a function body, the search path, a preload, the harness folders): a command under one is judged. */
const RUNS_CODE = new RegExp(`^(PATH|IFS|ENV|BASH_ENV|BASH_FUNC_.*|BASHOPTS|SHELLOPTS|PS[0-9]|PROMPT_COMMAND|CDPATH|GLOBIGNORE|LD_.*|DYLD_.*|${HARNESS_NAMES.join("|")})$`);
const steersCode = (a: Assign | undefined): boolean => !!a && !harmless(a) && RUNS_CODE.test(a.name);

/** A standalone `NAME=literal`: no expansion in the value, no append, a name that steers nothing. It names a string for later words, which are read as they stand (an unresolved `$NAME` stays opaque). */
const literalAssign = (a: Assign): boolean => !a.append && a.value !== null && !STEERING.test(a.name);

/** The command substitutions and process substitutions inside `node`, not descending into their scripts. */
function scriptsIn(node: SyntaxNode, acc: { subs: Array<{ script: Script | undefined; label: string }>; proc: boolean }): void {
  const stack: SyntaxNode[] = [];
  const push = (n: SyntaxNode): void => {
    const kids: SyntaxNode[] = [];
    forEachChild(n, (c: SyntaxNode) => {
      kids.push(c);
    });
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  };
  push(node);
  while (stack.length) {
    const c = stack.pop()!;
    const x = c as any;
    if (x.type === "CommandExpansion" || x.type === "ArithmeticCommandExpansion" || x.type === "ProcessSubstitution") {
      if (x.type === "ProcessSubstitution") acc.proc = true;
      acc.subs.push({ script: x.script, label: String(x.text).startsWith("`") ? "`" : "$(" });
      continue;
    }
    push(c);
  }
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
  // always set (true or false), like `stdinFed`: a copy that lost them reads undefined (see `carryFacts`)
  Object.defineProperty(out, "programUnknown", { value: sc.unit !== undefined && !!sc.run.unsafe?.has(sc.unit), enumerable: false, configurable: true, writable: true });
  Object.defineProperty(out, "harnessRebound", { value: reboundAt(sc), enumerable: false, configurable: true, writable: true });
  // the shell is in a folder a variable or a substitution named: a file run by a relative name is not the file the walk's cwd says (not in a look-behind trial: a word after an unknown program is mostly an operand, `curl -o a https://x`)
  if (sc.run.flow?.dyn && (!sc.run.behind || sc.run.behindRuns) && runsRelative(program, argv)) Object.defineProperty(out, "programUnknown", { value: true, enumerable: false, configurable: true, writable: true });
  if (sc.fnStack?.length) Object.defineProperty(out, "walked", { value: true, enumerable: false, configurable: true, writable: true });
  sc.run.out.push(out);
}

/**
 * Whether `program` with `argv` runs a file named relative to the folder the shell is in: a program word with a `/` that is no absolute or `~` path (`./x.sh`, `sub/x`), the first operand of an interpreter
 * (`sh ./x.sh`, `bash x.sh`, `python3 ./x.py`) or the file operand of `source` / `.`.
 */
function runsRelative(program: string, argv: string[]): boolean {
  const relative = (w: string): boolean => !w.startsWith("~") && !path.posix.isAbsolute(w) && !path.win32.isAbsolute(w);
  if (/[\\/]/.test(program)) return relative(program);
  const b = baseName(program);
  if (b === "source" || b === ".") {
    const f = argv[argv[0] === "--" ? 1 : 0];
    return f !== undefined && relative(f);
  }
  if (INTERPRETERS.has(b)) {
    const f = argv.find((a) => !a.startsWith("-"));
    return f !== undefined && relative(f);
  }
  return false;
}

/** The harness names the line may have rebound at the run unit of `sc` (the names the caller handed in too); a segment outside any unit gets every name. */
function reboundAt(sc: Scope): string[] {
  const rn = sc.run;
  if (rn.trial) return [];
  if (sc.startup) return HARNESS_NAMES;
  const own = sc.unit === undefined ? (rn.rebound ? HARNESS_NAMES : []) : (rn.rebound?.[sc.unit] ?? []);
  // a name the wrapped run clears or unsets (`env -i`, `env -u FOREMAN_SCRATCH`, `exec -c`) is empty for it: no longer the folder
  const wiped = HARNESS_NAMES.filter((n) => sc.wiped?.includes("*") || sc.wiped?.includes(n));
  return [...new Set([...(rn.seed ?? []), ...own, ...wiped])];
}

/** Marks the segment just emitted as one whose program the walk did not state (`ShellSegment.programUnknown`). */
function markUnknown(sc: Scope): void {
  const last = sc.run.out[sc.run.out.length - 1];
  if (last) Object.defineProperty(last, "programUnknown", { value: true, enumerable: false, configurable: true, writable: true });
}

/** Hangs the body texts on the segment just emitted (not enumerable: a segment's own keys stay as they were). */
function withBodies(sc: Scope, bodies: string[]): void {
  const last = sc.run.out[sc.run.out.length - 1];
  if (sc.inSelect) return;
  if (last && bodies.length > 0) {
    Object.defineProperty(last, "bodies", { value: bodies, enumerable: false });
    // the constants stand only while the line has not rebound them by this unit
    // a body may run at any point of the line: the names rebound by its last unit
    const gone = reboundAt({ ...sc, unit: Math.max((sc.run.rebound?.length ?? 1) - 1, 0) });
    Object.defineProperty(last, "bodyConsts", { value: (sc.consts ?? []).filter((n) => !gone.includes(n)), enumerable: false });
  }
}

function walkSubs(subs: Array<{ script: Script | undefined; label: string }>, sc: Scope): void {
  for (const s of subs) {
    if (sc.depth + 1 > MAX_DEPTH) {
      seg(sc, s.label, [], "depth");
      markUnknown(sc);
      // the script inside was never walked: a consumer must not read the segment as a plain unresolved word
      if (s.script && s.script.commands.length > 0) Object.defineProperty(sc.run.out[sc.run.out.length - 1], "tooDeep", { value: true, enumerable: false });
    }
    else if (!s.script || s.script.errors?.length) {
      // a shell runs the statements before the error: they are walked as written (the floors and write checks read them), then the error stays one opaque segment
      const at = (s.script?.errors as Array<{ pos: number }> | undefined)?.[0]?.pos;
      const before = at === undefined ? [] : s.script!.commands.filter((st) => st.end > st.pos && st.end <= at);
      if (before.length > 0 && sc.depth + 1 <= MAX_DEPTH) isolated(sc.run, () => walkList(before, { ...sc, depth: sc.depth + 1, wrappers: [...sc.wrappers, s.label], stdin: false, redirects: [], heredoc: false, docs: [], reason: null, pipe: undefined }));
      seg(sc, s.label, [], "parse_error");
    }
    else {
      const body = s.script.commands;
      isolated(sc.run, () => walkList(body, { ...sc, depth: sc.depth + 1, wrappers: [...sc.wrappers, s.label], stdin: false, redirects: [], heredoc: false, docs: [], reason: null, pipe: undefined }));
    }
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
    // a background job is a subshell
    const end = st.background ? isolated(sc.run, () => walkNode(st.command, { ...sc, cwd })) : walkNode(st.command, { ...sc, cwd });
    if (!st.background) cwd = end;
  }
  return cwd;
}

/** Walks `lists` (branches of one construct); the cwd after is the start cwd unless a list changed it (then unknown). */
function walkLists(lists: Array<CompoundList | undefined>, sc: Scope): string | null {
  let cwd = sc.cwd;
  let changed = false;
  conditional(sc.run, () => {
    for (const l of lists) {
      if (!l) continue;
      if (walkList(l.commands, { ...sc, cwd }) !== cwd) {
        changed = true;
        cwd = null;
      }
    }
  });
  return changed ? null : sc.cwd;
}

function walkWords(words: readonly Word[] | undefined, sc: Scope): void {
  const acc = { subs: [] as Array<{ script: Script | undefined; label: string }>, proc: false };
  for (const w of words ?? []) scriptsIn(w, acc);
  walkSubs(acc.subs, sc);
}

function walkNode(n: any, sc: Scope): string | null {
  // a run unit of the line itself (`unitNodes`): everything below it, nested strings included, belongs to it
  if (sc.unit === undefined) {
    const u = sc.run.unitOf?.get(n);
    if (u !== undefined) sc = { ...sc, unit: u };
  }
  switch (n.type) {
    case "Command":
      return doCommand(n as Command, sc);
    case "Pipeline": {
      let docs = sc.docs;
      const id = (sc.run.pipes = (sc.run.pipes ?? 0) + 1);
      (n.commands as CommandNode[]).forEach((cmd, i) => {
        const before = sc.run.out.length;
        isolated(sc.run, () => walkNode(cmd, { ...sc, docs, stdin: sc.stdin || i > 0, pipe: { id, stage: i } }));
        // a here-document of one command flows down the pipe: the shell at the end of `cat <<E | bash` reads its body as code
        const fed = sc.run.out.slice(before).flatMap((x) => x.heredocs ?? []);
        if (fed.length) docs = [...new Set([...docs, ...fed])];
      });
      return sc.cwd;
    }
    case "AndOr": {
      let cwd = sc.cwd;
      (n.commands as CommandNode[]).forEach((cmd, i) => {
        const go = (): string | null => walkNode(cmd, { ...sc, cwd });
        const end = i > 0 && n.operators[i - 1] === "||" ? conditional(sc.run, go) : go();
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
      isolated(sc.run, () => walkList(n.body.commands, sc));
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
      // a case may hold no command: its subject or a pattern with arithmetic on a value not shown to be a number is still a site, so the unit gets a segment to carry the mark
      if (sc.unit !== undefined && sc.run.unsafe?.has(sc.unit)) seg(sc, "", [], null);
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
      // the substitutions inside a `[[ ]]` test and a select's word list and body run: they are real segments next to the opaque one (which still keeps any allow off the line)
      if (n.type === "TestCommand") {
        const acc = { subs: [] as Array<{ script: Script | undefined; label: string }>, proc: false };
        scriptsIn(n, acc);
        walkSubs(acc.subs, sc);
      } else if (n.type === "Select") {
        walkWords(n.wordlist, sc);
        walkLists([n.body], { ...sc, inSelect: true });
      }
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
    const ok = sc.run.assignOk.has(cmd) || prefix.every((a) => a.assign && (harmless(a.assign) || literalAssign(a.assign)));
    seg(sc, "", [], ok ? null : "assignment", c);
    if (prefix.some((a) => steersCode(a.assign))) markUnknown(sc);
    return sc.cwd;
  }
  for (const a of prefix) if (!(a.assign && harmless(a.assign))) c.reason = pick(c.reason, "assignment");
  const before = sc.run.out.length;
  const end = run(words, c, sc.cwd);
  if (prefix.some((a) => steersCode(a.assign)) && sc.run.out.length > before) markUnknown(sc);
  return end;
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

/** The word `$PWD` or `${PWD}`, bare or in double quotes. */
const PWD_WORD = /^"?\$(?:PWD|\{PWD\})"?$/;

/** The line may bind PWD (an assignment, `cd` through a bound name, `read`, `eval` ...): `boundNames` answers for any name it cannot rule out. */
const pwdBound = (root: string): boolean => {
  const b = boundNames(root);
  return b.any || b.names.has("PWD");
};

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
        // `git -C "$PWD"` names the folder the walk tracks, while nothing on the line binds PWD: the word is that folder (the base allowed it; an unreadable `-C` target is judged)
        const w = rest[i + 1];
        if (w && w.value === null && at !== null && PWD_WORD.test(w.text) && sc.run.root !== undefined && !pwdBound(sc.run.root)) rest = rest.map((a, k) => (k === i + 1 ? { ...a, value: at as string, reason: null } : a));
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
  // `builtin x ...` runs x, which is not unwrapped (that would make `builtin cd` known-safe); `find -exec $C ...` runs a program the word does not name
  if ((name === "builtin" && rest.length > 0) || (name === "find" && rest.some((a, i) => FIND_EXEC.has(a.value ?? "") && rest[i + 1] && rest[i + 1].value === null && !rest[i + 1].lit))) markUnknown(sc);
  return cwd;
}

/** `runStringIn`, and a text that holds the replace string of an enclosing `xargs -I` is a text the input fills in: the walk marks it unknown. */
function runString(label: string, src: string, c: Cmd, cwd: string | null): string | null {
  const replaced = !!c.sc.replace && src.includes(c.sc.replace);
  const before = c.sc.run.out.length;
  // `eval` runs in this shell: what its text does to the folder state stays (and what it clears does not count); any other string is a shell of its own
  const evaluated = label === "eval";
  const go = (): { end: string | null; inner: string | null } => runStringIn(label, src, c, cwd);
  const { end, inner } = evaluated ? conditional(c.sc.run, go) : isolated(c.sc.run, go);
  // an `eval` that moves the shell: the folder after it is not the one the walk keeps, so the line is judged
  if (evaluated && inner !== cwd && c.sc.run.out.length > before) markUnknown(c.sc);
  if (replaced) {
    if (c.sc.run.out.length === before) seg(c.sc, label, [src], null, c);
    markUnknown(c.sc);
  }
  return end;
}

/** Parses `src` as a nested script (bash -c, eval, watch, flock -c) and walks it. */
function runStringIn(label: string, src: string, c: Cmd, cwd: string | null): { end: string | null; inner: string | null } {
  const sc: Scope = { ...c.sc, cwd, xargs: false, wrappers: [...c.sc.wrappers, label] };
  sc.run.strings.push(src);
  if (sc.depth + 1 > MAX_DEPTH) {
    seg(sc, label, [], "depth", c);
    markUnknown(sc);
    withBodies(sc, opaqueBodies(src, false));
    return { end: cwd, inner: cwd };
  }
  let script: Script | undefined;
  try {
    script = parse(src);
  } catch {
    script = undefined;
  }
  if (!script || (script as any).errors?.length) {
    seg(sc, label, [src], "parse_error", c);
    return { end: cwd, inner: cwd };
  }
  const before = sc.run.out.length;
  const inner = walkScript(script, src, { ...sc, depth: sc.depth + 1, wiped: sc.cleared, redirects: c.redirs, heredoc: c.heredoc, docs: c.docs, stdin: c.feeds, reason: c.reason });
  // arithmetic in the text on a value not shown to be a number (`eval '(( x = $(...) ))'`): judged as the same text written inline, whose unit the line's own analysis marks
  if (sc.run.out.length > before && analyse(src).unsafe.size > 0) markUnknown(sc);
  return { end: cwd, inner };
}

/** A `~` word whose last part is plain and that does not climb (`~/p`): the home folder spelled out, a literal target. */
const tildeLiteral = (w: W): boolean => w.value === null && w.text.startsWith("~") && !!w.lit && !(w.decoded ?? w.text).split("/").includes("..");

/**
 * What a `cd`, `pushd` or `popd` does to the folder flow (see `Flow`): a target the walk cannot read (a variable, a substitution) sets it; once a line has done that, `popd`, `cd -` and a `pushd` with no literal target
 * may land anywhere and set it too; a `cd` to a literal absolute path that runs unconditionally clears it.
 */
function noteFolder(fl: Flow | undefined, name: string, rest: W[]): void {
  if (!fl) return;
  if (rest.some((a) => a.value === null && !tildeLiteral(a))) {
    fl.dyn = true;
    fl.any = true;
    return;
  }
  const one = rest.length === 1 ? rest[0].value : null;
  if (name === "popd" || (name === "pushd" && (one === null || /^[-+]/.test(one))) || (name === "cd" && one === "-")) {
    if (fl.any) fl.dyn = true;
  } else if (name === "cd" && one !== null && fl.cond === 0 && (path.posix.isAbsolute(one) || path.win32.isAbsolute(one))) fl.dyn = false;
}

/** The most function bodies one line walks at their calls; past it the call is unknown. */
const MAX_BODY_WALKS = 64;

/** The most commands one line walks inside function bodies (a body of hundreds of commands called many times, bodies defined inside bodies); past it a call is unknown, so the work stays bounded and never opens. */
const MAX_BODY_CMDS = 500;

/**
 * One command whose words are resolved. A program word that names a function the line defines runs every body of that name, in any order the line has them (a definition may come later, or twice): each
 * body is walked here, at the call, as real segments, then the command is read as it stands (a function may also shadow a wrapper or a builtin, which keeps its own handling). The call is unknown (judge-first)
 * when a body takes the call's words (`$1`, `$@`, `shift`), ends in another folder, cannot be read or walked, or the budget is spent.
 */
function run(words: W[], c: Cmd, cwd: string | null): string | null {
  const sc = c.sc;
  const name = words[0]?.value;
  const bodies = name != null && !/[\\/]/.test(name) ? sc.run.funcs?.get(name) : undefined;
  if (sc.fnStack?.length && sc.run.budget && ++sc.run.budget.cmds > MAX_BODY_CMDS) return cwd; // the budget is spent inside the walk: the rest of the body is not read, and the call that started it is unknown
  if (name == null || !bodies) return runWord(words, c, cwd);
  const before = sc.run.out.length;
  let unknown = false;
  for (const body of bodies) {
    // a call of a function from inside its own body is the walk already under way
    if (sc.fnStack?.includes(name)) continue;
    const budget = sc.run.budget;
    if (!budget || budget.walks >= MAX_BODY_WALKS || budget.cmds > MAX_BODY_CMDS || sc.depth + 1 > MAX_DEPTH) {
      unknown = true;
      continue;
    }
    budget.walks++;
    const r = walkBody(body, name, c, cwd);
    if (!r.ok || r.end !== cwd || r.positional || budget.cmds > MAX_BODY_CMDS) unknown = true;
  }
  const end = runWord(words, c, cwd);
  for (const x of sc.run.out.slice(before)) if (x.program === name) sc.run.resolved?.add(x);
  if (unknown) markUnknown(sc);
  return end;
}

/** Visits `root` and its descendants in document order with an explicit stack (a long arithmetic sum is a left-deep tree: recursion over it overflows); `fn` returns false to leave a node's children unvisited. */
function preorder(root: SyntaxNode, fn: (n: SyntaxNode) => boolean | void): void {
  const stack: SyntaxNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (fn(n) === false) continue;
    const kids: SyntaxNode[] = [];
    forEachChild(n, (c: SyntaxNode) => {
      kids.push(c);
    });
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
}

/** The body text of every function the script defines, collected into the run's `funcs` (also definitions nested in other bodies and in substitutions). */
function collectFuncs(script: Script, src: string, rn: Run): void {
  const funcs = rn.funcs;
  if (!funcs) return;
  preorder(script as SyntaxNode, (n) => {
    if (n.type === "Function") {
      const name = String((n as any).name.text);
      const have = funcs.get(name) ?? [];
      for (const b of nodeBodies(n, src)) if (!have.includes(b)) have.push(b);
      funcs.set(name, have);
    }
  });
}

/** Whether the script takes the words of a call: a positional parameter (`$1`..`$9`, `${10}`, `$@`, `$*`, `$#`) or `shift`, read from the parser's nodes. */
function usesPositional(script: Script): boolean {
  let found = false;
  preorder(script as SyntaxNode, (n) => {
    if (found) return false;
    const x = n as any;
    if (x.type === "SimpleExpansion" && /^[0-9@*#]$/.test(String(x.text).slice(1))) found = true;
    else if (x.type === "ParameterExpansion" && /^(?:\d+|[@*#])$/.test(String(x.parameter))) found = true;
    else if (x.type === "Command" && x.name?.text === "shift") found = true;
    return !found;
  });
  return found;
}

/** Walks one function body at its call: parsed as a nested script in the call's folder; `end` is the folder the body ends in, `ok` false when the body does not parse. */
function walkBody(src: string, name: string, c: Cmd, cwd: string | null): { ok: boolean; end: string | null; positional: boolean } {
  let script: Script | undefined;
  try {
    script = parse(src);
  } catch {
    script = undefined;
  }
  if (!script || (script as any).errors?.length) return { ok: false, end: cwd, positional: false };
  const sc: Scope = { ...c.sc, cwd, xargs: false, depth: c.sc.depth + 1, fnStack: [...(c.sc.fnStack ?? []), name], redirects: c.redirs, heredoc: c.heredoc, docs: c.docs, stdin: c.feeds, reason: c.reason };
  sc.src = src;
  collectFuncs(script, src, sc.run);
  prepare(script, src, sc);
  // a body leaves its folder state set but never clears it: the call may not run it
  const end = conditional(sc.run, () => walkList(script.commands, sc));
  return { ok: true, end, positional: usesPositional(script) };
}

/** Emits the segment of one command whose words are resolved: unwrap the wrappers, emit the segment of the program. */
function runWord(words: W[], c: Cmd, cwd: string | null): string | null {
  const sc = c.sc;
  const p = words[0];
  const rest = words.slice(1);
  if (p.value === null) {
    // `$V/bin/pip`: the program is named by the literal basename after the expansion; the name goes through the same lookup a literal program does, so the segment is not opaque for its program word
    const leaf = p.tail?.split(/[\\/]/).pop();
    if (leaf) {
      const n = sc.run.out.length;
      run([{ text: p.text, value: leaf, reason: null }, ...rest], c, cwd);
      // a tilde program stays path-qualified in its segment (`~/bin/cat` is no known `cat`); a wrapper (`~/../../usr/bin/env rm`) emitted the wrapped program, which keeps its own name
      const last = sc.run.out[n];
      if (p.text.startsWith("~") && sc.run.out.length === n + 1 && last.wrappers.length === sc.wrappers.length && last.program.toLowerCase() === leaf.toLowerCase()) last.program = p.decoded ?? p.text;
      // bash runs no builtin for a word holding a slash: the leaf walk (`~/bin/cd`, `~/bin/pushd`, `env -C`) cannot move the calling shell
      return cwd;
    }
    seg(sc, p.text, rest.map((a) => a.value ?? a.text), p.reason ?? "unresolved_var", c, cwd);
    // only a program reduced to a name above (a leaf) is read by the walk; any other opaque program word is unknown
    markUnknown(sc);
    return cwd;
  }
  // under `xargs -I`, a program word that holds the replace string is (partly) the input: judge-first, and the words behind it are still walked (`xargs -I e env rm -rf /x`)
  if (sc.replace && p.text.includes(sc.replace)) {
    seg(sc, p.text, rest.map((a) => a.value ?? a.text), "unsupported", c, cwd);
    markUnknown(sc);
  }
  const prog = p.value;
  const name = baseName(prog);
  const wrap = (inner: W[], w: string, at = cwd, pass = false, clears: string[] = [], login = false): string | null => {
    if (!inner.length) {
      const r = plain(prog, name, [], c, cwd);
      // under an `xargs` the input is the command (`xargs env`, `xargs nice`, `xargs timeout 5`)
      if (sc.xargs) markUnknown(sc);
      return r;
    }
    return run(inner, { ...c, sc: { ...sc, ...(login ? { startup: true } : {}), wrappers: [...sc.wrappers, w], passAt: pass ? [...(sc.passAt ?? []), sc.wrappers.length] : sc.passAt, cleared: clears.length ? [...(sc.cleared ?? []), ...clears] : sc.cleared } }, at);
  };
  const bad = (reason: OpaqueReason, unknown = false): string | null => {
    seg(sc, prog, rest.map((a) => a.value ?? a.text), reason, c, cwd);
    // the wrapped program was not walked: an option, an argument or the program position holds something this walker does not read
    if (unknown) markUnknown(sc);
    return cwd;
  };
  const opts = (spec: OptSpec) => parseOpts(rest, spec);
  const strOf = (list: W[]): string | null => (list.every((a) => a.value !== null) ? list.map((a) => a.value).join(" ") : null);
  if (FOREIGN.has(name) || FOREIGN_FILE.test(prog)) return plain(prog, name, rest, c, cwd);

  switch (name) {
    case "cd":
    case "pushd": {
      plain(prog, name, rest, c, cwd);
      // bash runs no builtin for a word holding a slash (`/x/cd DIR`): the directory stays
      if (/[\\/]/.test(prog)) return cwd;
      noteFolder(sc.run.flow, name, rest);
      // `pushd` with an option moves nothing we track; `popd` is not tracked at all
      const one = rest.length === 1 && rest[0].value !== null && !(name === "pushd" && /^[-+]/.test(rest[0].value)) ? rest[0].value : null;
      return one === null ? null : (cdTarget(["cd", one], cwd ?? undefined, win32(sc.run)) ?? null);
    }
    case "popd":
      plain(prog, name, rest, c, cwd);
      if (/[\\/]/.test(prog)) return cwd;
      noteFolder(sc.run.flow, name, rest);
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
      let startup = false;
      for (; i < rest.length; i++) {
        const v = rest[i].value;
        if (v === null) return bad(cflag ? "nonliteral_script" : (rest[i].reason ?? "unresolved_var"), !rest[i].lit);
        if (v === "--") {
          i++;
          break;
        }
        if (v.startsWith("--")) {
          if (v === "--login") startup = true;
          if (!["--login", "--noprofile", "--norc", "--posix", "--restricted", "--verbose", "--noediting", "--version", "--help"].includes(v)) return bad("wrapper_option", true);
        } else if (/^[-+][A-Za-z]/.test(v)) {
          for (const ch of v.slice(1)) {
            if (ch === "c") cflag = true;
            else if (ch === "s") sflag = true;
            else if (ch === "l" || ch === "i") startup = true;
            else if (ch === "o" || ch === "O") i++;
          }
        } else break;
      }
      // under an `xargs` the input is the script (`xargs bash`, `xargs sh -c`)
      if (!cflag || !rest[i]) {
        const r = plain(prog, name, rest, c, cwd, !cflag && sflag);
        if (sc.xargs && !rest[i]) markUnknown(sc);
        return r;
      }
      const script = rest[i];
      if (script.value === null) return bad("nonliteral_script");
      return runString(name, script.value, startup ? { ...c, sc: { ...c.sc, startup: true } } : c, cwd);
    }
    case "eval": {
      if (!rest.length) {
        const r = plain(prog, name, rest, c, cwd);
        if (sc.xargs) markUnknown(sc);
        return r;
      }
      const s = strOf(rest);
      return s === null ? bad("nonliteral_script") : runString("eval", s, c, cwd);
    }
    case "env": {
      const o = opts({ flags: "i0v", arg: "uC", long: ["--ignore-environment", "--null", "--debug", "--verbose"], longArg: ["--unset", "--chdir"] });
      if (typeof o === "string") return bad(o, true);
      let args = o.rest;
      const clears = o.opts.filter((x) => x.name === "-u" || x.name === "--unset").map((x) => x.value ?? "");
      if (has(o.opts, "-i", "--ignore-environment") || args[0]?.value === "-") clears.push("*");
      if (args[0]?.value === "-") args = args.slice(1);
      let at = cwd;
      const dir = val(o.opts, "-C", "--chdir");
      if (dir !== null) at = cdTarget(["cd", dir], cwd ?? undefined, win32(sc.run)) ?? null;
      // env's own rule: every operand with an `=` before the program is a setting; a name that is not a shell identifier (an exported function, `A-B=1`) is read by the program, which may rebind anything
      let startup = false;
      let odd = false;
      let steers = false;
      while (args.length && !(args[0].value ?? args[0].text).startsWith("-") && (args[0].value ?? args[0].text).includes("=")) {
        const a = args[0].assign ?? asAssign(args[0]);
        if (!a) {
          odd = true;
          startup = true;
          c.reason = pick(c.reason, "assignment");
        } else {
          if (!harmless(a)) c.reason = pick(c.reason, "assignment");
          if (steersCode(a)) steers = true;
          // a harness folder name set here is rebound for the wrapped program, whatever wrapper or `env` sits between
          if (RUNS_FILE_VARS.has(a.name) || HARNESS_NAMES.includes(a.name)) startup = true;
        }
        args = args.slice(1);
      }
      wrap(args, "env", at, true, clears, startup);
      if (odd || steers) markUnknown(sc);
      return cwd;
    }
    case "timeout": {
      const o = opts({ flags: "v", arg: "ks", long: ["--foreground", "--preserve-status", "--verbose"], longArg: ["--kill-after", "--signal"] });
      if (typeof o === "string") return bad(o, true);
      if (o.rest[0] && o.rest[0].value === null) return bad(o.rest[0].reason ?? "unresolved_var", true);
      return wrap(o.rest.slice(1), "timeout", undefined, true);
    }
    case "nice": {
      const o = opts({ arg: "n", numeric: true, longArg: ["--adjustment"] });
      return typeof o === "string" ? bad(o, true) : wrap(o.rest, "nice", undefined, true);
    }
    case "nohup": {
      const o = opts({});
      if (typeof o === "string") return bad(o, true);
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
      if (typeof o === "string") return bad(o, true);
      c.reason = pick(c.reason, "xargs_stdin");
      if (!o.rest.length) {
        seg({ ...sc, wrappers: [...sc.wrappers, "xargs"] }, "echo", [], null, c, cwd);
        return cwd;
      }
      // the replace string of `-I`, `-i`, `-J`, `--replace`: the input stands in its place in the wrapped words
      const rs = o.opts.find((x) => x.name === "-I" || x.name === "-J" || x.name === "--replace");
      const replace = rs ? (rs.value ?? "{}") : has(o.opts, "-i") ? "{}" : undefined;
      return run(o.rest, { ...c, sc: { ...sc, wrappers: [...sc.wrappers, "xargs"], xargs: true, ...(replace ? { replace } : {}) } }, cwd);
    }
    case "time": {
      const o = opts({ flags: "pvalhq", arg: "fo", long: ["--portability", "--verbose", "--append", "--quiet"], longArg: ["--format", "--output"] });
      if (typeof o === "string") return bad(o, true);
      if (has(o.opts, "-o", "--output")) c.reason = pick(c.reason, "writing_wrapper");
      return wrap(o.rest, "time");
    }
    case "command": {
      const o = opts({ flags: "pvV" });
      if (typeof o === "string" || has(o.opts, "-v", "-V")) {
        plain(prog, name, rest, c, cwd);
        // `command --x rm ...`: an option this walker does not read, the program behind it was not walked
        if (typeof o === "string") markUnknown(sc);
        return cwd;
      }
      return wrap(o.rest, "command", undefined, true);
    }
    case "exec": {
      // `exec [-cl] [-a name] cmd args`: the command is the segment; the redirect-only form (no command) stays the opaque builtin
      const o = opts({ flags: "cl", arg: "a" });
      if (typeof o === "string" || !o.rest.length) return bad("shell_builtin", typeof o === "string");
      // a failed `exec cd` (execfail) leaves the shell where it was: the inner command's cwd is not taken over, as for `env`
      // `exec -l` and `exec -a -name` (argv0 starting with `-`) start the program as a login shell, which reads startup files like `bash -l`
      const login = has(o.opts, "-l") || o.opts.some((x) => x.name === "-a" && (x.value ?? "").startsWith("-"));
      wrap(o.rest, "exec", cwd, false, has(o.opts, "-c") ? ["*"] : [], login);
      return cwd;
    }
    case "stdbuf": {
      const o = opts({ arg: "ioe", longArg: ["--input", "--output", "--error"] });
      return typeof o === "string" ? bad(o, true) : wrap(o.rest, "stdbuf", undefined, true);
    }
    case "setsid": {
      const o = opts({ flags: "cfw", long: ["--ctty", "--fork", "--wait"] });
      return typeof o === "string" ? bad(o, true) : wrap(o.rest, "setsid", undefined, true);
    }
    case "watch": {
      const o = opts({
        flags: "bcCdegptwxrvh",
        arg: "nq",
        long: ["--beep", "--color", "--no-color", "--differences", "--errexit", "--chgexit", "--precise", "--no-title", "--no-linewrap", "--exec", "--no-rerun", "--version", "--help"],
        longArg: ["--interval", "--equexit"],
      });
      if (typeof o === "string") return bad(o, true);
      if (has(o.opts, "-x", "--exec")) return wrap(o.rest, "watch");
      if (!o.rest.length) return plain(prog, name, rest, c, cwd);
      const s = strOf(o.rest);
      return s === null ? bad("nonliteral_script") : runString("watch", s, c, cwd);
    }
    case "flock": {
      const o = opts({ flags: "sexunoF", arg: "wEc", long: ["--shared", "--exclusive", "--unlock", "--nonblock", "--nb", "--close", "--no-fork"], longArg: ["--timeout", "--wait", "--conflict-exit-code", "--command"] });
      if (typeof o === "string") return bad(o, true);
      const file = o.rest[0];
      if (file && !/^\d+$/.test(file.value ?? "")) c.reason = pick(c.reason, "writing_wrapper");
      if (has(o.opts, "-c", "--command")) return runString("flock", val(o.opts, "-c", "--command") ?? "", c, cwd);
      if (file && (o.rest[1]?.value === "-c" || o.rest[1]?.value === "--command")) {
        const s = o.rest[2];
        return !s || s.value === null || o.rest.length > 3 ? bad("nonliteral_script") : runString("flock", s.value, c, cwd);
      }
      return o.rest.length > 1 ? wrap(o.rest.slice(1), "flock") : plain(prog, name, rest, c, cwd);
    }
    case "busybox":
    case "toybox": {
      // a literal applet word is the program (`busybox sh -c ..` reads as `sh -c ..`); anything else names a program this walker does not read
      const applet = rest[0];
      if (!applet || applet.value === null || applet.value.startsWith("-")) return bad("unsupported", true);
      bad("unsupported");
      return wrap(rest, name, undefined, true);
    }
    case "alias": {
      plain(prog, name, rest, c, cwd);
      // a definition (`alias x='rm -rf ~'`): a later call of the name runs text this walk does not follow, so the line is judged; a literal value is also read as the command it names
      const defs = rest.filter((a) => a.value === null || (!a.value.startsWith("-") && a.value.includes("=")));
      if (defs.length) markUnknown(sc);
      for (const a of defs) {
        const v = a.value === null ? null : (a.assign ?? asAssign(a))?.value;
        if (v) runString("alias", v, c, cwd);
      }
      return cwd;
    }
    case "source":
    case ".": {
      // the file operand (the first word after an optional `--`): a word the walk cannot read, or a stream, runs code that is not in the line; a literal file keeps its handling
      const file = rest[rest[0]?.value === "--" ? 1 : 0];
      if (file && sourcesStream(file)) return bad("unsupported", true);
      return bad(runnerReason(name));
    }
    case "trap": {
      // `trap 'cmd' SIG`: the action runs later in this shell; a literal one is read as the command it holds (as an alias value is), any other makes the line judged. `-l`, `-p` and `-` hold none.
      const r = plain(prog, name, rest, c, cwd);
      const act = rest.find((a) => a.value === null || !a.value.startsWith("-") || a.value === "-");
      if (act && act.value === null) markUnknown(sc);
      else if (act && act.value !== "-" && act.value !== "") runString("trap", act.value as string, c, cwd);
      return r;
    }
    default:
      // a runner the walker does not unwrap (`ionice`, `chroot`, `unbuffer`, `parallel`): the program behind it was not walked
      if (RUNNERS.has(name) && !BUILTINS.has(name) && name !== "script") return bad(runnerReason(name), runnerReason(name) === "unsupported");
      if (sc.xargs && INTERPRETERS.has(name) && !rest.some((a) => a.value === null || !a.value.startsWith("-"))) {
        // an interpreter with no script word under an `xargs`: the input names the script
        const r = plain(prog, name, rest, c, cwd);
        markUnknown(sc);
        return r;
      }
      const r = plain(prog, name, rest, c, cwd);
      lookBehind(name, rest, c, cwd);
      if (name === "find") lookBehindExec(rest, c, cwd);
      if (name === "compgen" || name === "readarray" || name === "mapfile") callbackOption(rest, c, cwd);
      return r;
  }
}

/** The programs the walker or a table already models: a runner, builtin, interpreter, foreign shell, `declare`-family or assigning builtin, a program the effect classification names, a read program of the floors. */
const modelled = (name: string): boolean =>
  RUNNERS.has(name) || BUILTINS.has(name) || INTERPRETERS.has(name) || FOREIGN.has(name) || DECLARE.has(name) || ASSIGNING.has(name) || name === "hash" || name === "unset" || READ_PROGS.has(name) || effectsNames(name);

/** The most words of one unmodelled program that `lookBehind` starts a walk at; more literal words make the segment unknown. */
const BEHIND_STARTS = 32;

/** The most look-behind walks one line starts (each is read again by the floors and the judge-first rules); past it the segment is unknown, so the work stays bounded and never opens. */
const BEHIND_BUDGET = 1000;

/**
 * A program no table models may start the words after it (`caffeinate rm -rf x`, `taskset 1 rm -rf x`, `strace rm x`): the words from each literal one on are walked as a command of their own in a trial run
 * (no look-behind inside it), and hang on the segment just emitted as `behind`. Nothing here adds a segment to the line's own list.
 */
function lookBehind(name: string, rest: W[], c: Cmd, cwd: string | null): void {
  // inside a trial only `npx` (it starts the program it is given) looks behind again: the program of `npx sh -c 'find . -exec ...'` is not an operand of an unknown one
  if ((c.sc.run.behind && name !== "npx") || (modelled(name) && name !== "npx")) return;
  attachBehind(rest, rest.flatMap((a, k) => (a.value !== null && !a.value.startsWith("-") ? [k] : [])), c, cwd, name === "npx");
}

/** `find -exec CMD ... ;`: the words after each exec action read as a command of their own (`find . -exec sh -c 'rm x' \;`), like the words behind an unmodelled program. */
function lookBehindExec(rest: W[], c: Cmd, cwd: string | null): void {
  attachBehind(rest, rest.flatMap((a, k) => (FIND_EXEC.has(a.value ?? "") && rest[k + 1] && rest[k + 1].value !== null ? [k + 1] : [])), c, cwd, true);
}

/** `compgen -C CMD`, `readarray -C CMD`: the callback command is run by the shell; a literal one is read as the command it holds, any other makes the segment unknown. */
function callbackOption(rest: W[], c: Cmd, cwd: string | null): void {
  for (let k = 0; k < rest.length; k++) {
    const v = rest[k].value;
    const attached = v !== null && /^-[A-Za-z]*C./.test(v) ? v.slice(v.indexOf("C") + 1) : null;
    if (v === null || !(/^-[A-Za-z]*C$/.test(v) || attached !== null)) continue;
    const a = attached !== null ? { value: attached, text: attached } : rest[k + 1];
    if (!a || a.value === null) markUnknown(c.sc);
    else runString("callback", a.value, c, cwd);
  }
}

/** Starts a trial walk at each of the `starts` words of `rest` and hangs the results on the segment just emitted (`ShellSegment.behind`). */
function attachBehind(rest: W[], starts: number[], c: Cmd, cwd: string | null, runs = false): void {
  const sc = c.sc;
  if (!starts.length) return;
  const real = sc.run.out[sc.run.out.length - 1];
  if (!real) return;
  const budget = sc.run.budget;
  if (starts.length > BEHIND_STARTS || !budget || budget.starts + starts.length > BEHIND_BUDGET) {
    markUnknown(sc);
    return;
  }
  budget.starts += starts.length;
  const behind = starts.map((k) => {
    const trial: Run = { ...sc.run, out: [], strings: [], behind: true, ...(runs ? { behindRuns: true } : {}), ...(sc.run.flow ? { flow: { ...sc.run.flow } } : {}) };
    run(rest.slice(k), { ...c, sc: { ...sc, run: trial } }, cwd);
    return { text: rest.slice(k).map((a) => a.value ?? a.text).join(" "), segments: trial.out };
  });
  Object.defineProperty(real, "behind", { value: behind, enumerable: false, configurable: true, writable: true });
}

/**
 * A `source` / `.` file operand that may be a stream or is not read: not literal (a variable, a substitution, a process substitution; a `~` word whose last part is plain keeps its handling unless
 * it climbs with `..`), or `-`, or a literal that names stdin or a file descriptor once normalised (`/dev//stdin`, `/proc/self/fd//0`).
 */
function sourcesStream(w: W): boolean {
  if (w.value === null) return !tildeLiteral(w);
  const v = path.posix.normalize(w.value);
  return v === "-" || v === "/dev/stdin" || v.startsWith("/dev/fd/") || v.startsWith("/proc/self/fd/") || /^\/proc\/[^/]+\/fd\//.test(v);
}

/** A pass-through wrapper whose words name a runner (`env sh`, `nohup bash`): the wrapped command runs text. */
const wrapsRunner = (x: any): boolean => (x.suffix ?? []).some((w: any) => typeof (w.value ?? w.text) === "string" && (RUNNERS.has(baseName(w.value ?? w.text)) || /[$`]/.test(w.text ?? "")));

/** The line holds a function definition, or a command that runs code or text (`eval`, `source`, `.`, a runner, a computed program name). `passing`: wrappers the walker unwrapped as pass-through (see `passNames`) do not count unless they wrap a runner (the constants `$FOREMAN_SCRATCH` and `$FOREMAN_OUT` only). */
function runsCode(node: SyntaxNode, passing: ReadonlySet<string> = new Set()): boolean {
  let found = false;
  preorder(node, (n) => {
    if (found) return false;
    const x = n as any;
    if (x.type === "Function") found = true;
    else if (x.type === "Command" && x.name && (/[$`]/.test(x.name.text) || (RUNNERS.has(baseName(x.name.value ?? x.name.text)) && !(passing.has(baseName(x.name.value ?? x.name.text)) && !wrapsRunner(x))))) found = true;
    return !found;
  });
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
  const probes: Array<{ cmd: Command; names: string[]; unit: string[]; at: number | undefined }> = [];
  // the run unit of each command of this script (`unitNodes` order); a script nested in a unit belongs to that unit
  let un = 0;
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
      const at = sc.unit ?? (rn.trial ? undefined : un);
      un++;
      if (sc.unit === undefined && !rn.trial) (rn.unitOf ??= new Map()).set(pn, at!);
      if (pn.type === "Pipeline") {
        const pipe = pn.commands.map(unitOf);
        // a pipeline stage is probed like a statement: only the child assignment substitution (A7) resolves anything in it
        for (const stage of pn.commands) {
          const names = stage.type === "Command" ? namesOf(stage as Command) : [];
          if (names.length) {
            const unit = names.map((n) => `$${n}`);
            pipe.push(unit);
            probes.push({ cmd: stage as Command, names, unit, at });
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
          probes.push({ cmd, names, unit, at });
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
    // the constants stand only up to the first run unit that may rebind them (`harnessRebound`)
    const gone = reboundAt({ ...sc, unit: pr.at });
    const later = (n: string): string | undefined => {
      if (n === "FOREMAN_SCRATCH" && scratchConst && !gone.includes(n)) return rn.env.FOREMAN_SCRATCH;
      if (n === "FOREMAN_OUT" && outConst && !gone.includes(n)) return rn.env.FOREMAN_OUT;
      const c = child.get(n);
      return c && c[1] <= pr.cmd.pos ? c[0] : undefined;
    };
    // a harness name the line may have rebound by this unit is no constant: whatever the closed grammar resolved it to (the rebound text) is not the folder
    rn.vars.set(pr.cmd, new Map(pr.names.map((n, k) => [n, HARNESS_NAMES.includes(n) && gone.includes(n) ? undefined : got && got[k] !== `$${n}` ? got[k] : later(n)])));
  }
  const stmts = grammarStatements(headerOf(src), rn.platform);
  cmds.forEach((cmd, i) => {
    if (cmd && !cmd.name && stmts && stmts[i]) rn.assignOk.add(cmd);
  });
}

function walkScript(script: Script, src: string, sc: Scope): string | null {
  sc.src = src;
  collectFuncs(script, src, sc.run);
  prepare(script, src, sc);
  return walkList(script.commands, sc);
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
 * one `parse_error` segment marked `tooDeep` (judge-first), none of the partial ones. Any other error propagates.
 */
export function parseShell(command: string, opts: ShellParseOptions = {}): ShellSegment[] {
  const start = (): Scope => {
    const run: Run = { out: [], vars: new Map(), assignOk: new Set(), env: opts.env ?? {}, platform: opts.platform ?? process.platform, strings: [], root: command, ...(opts.noCalls ? {} : { funcs: new Map() }), budget: { walks: 0, cmds: 0, starts: 0 }, resolved: new Set(), flow: { dyn: false, any: false, cond: 0 } };
    return { run, cwd: opts.cwd ?? null, wrappers: [], depth: 0, stdin: false, redirects: [], heredoc: false, docs: [], reason: null };
  };
  // `tooDeep`: a block, subshell or definition nested past the parser's limit is no syntax error (a shell runs it): the line is unread, so judge-first, never an allow
  const unreadable = (tooDeep = false): ShellSegment[] => {
    const sc = start();
    seg(sc, "", [], "parse_error");
    if (tooDeep) Object.defineProperty(sc.run.out[sc.run.out.length - 1], "tooDeep", { value: true, enumerable: false });
    return sc.run.out;
  };
  const sc = start();
  let script: Script | undefined;
  let overflow = false;
  try {
    script = parse(command);
  } catch (e) {
    script = undefined;
    overflow = e instanceof RangeError;
  }
  if (!script || (script as any).errors?.length) return unreadable(overflow || ((script as any)?.errors as { message?: string }[] | undefined)?.some((e) => /nesting depth exceeded/.test(e.message ?? "")) === true);
  try {
    const an = analyse(command);
    sc.run.rebound = an.rebound;
    sc.run.unsafe = an.unsafe;
    sc.run.seed = opts.rebound;
    walkScript(script, command, sc);
    // a segment that names a function the line defines, but was walked before the definition was known (one made inside a later `eval`): its body was not walked
    for (const x of sc.run.out) if (x.opaque !== "function_def" && sc.run.funcs?.has(x.program) && !sc.run.resolved?.has(x)) Object.defineProperty(x, "programUnknown", { value: true, enumerable: false, configurable: true, writable: true });
  } catch (e) {
    // a stack overflow in the walk is a line too deep to read, like nesting past the parser's limit: judge-first, never an allow
    if (e instanceof RangeError) return unreadable(true);
    throw e;
  }
  Object.defineProperty(sc.run.out, "strings", { value: sc.run.strings, enumerable: false });
  return sc.run.out;
}

/**
 * The texts a shell runs before the first parse error of `cmd`, cut by the parser's own offsets: the statements that end at or before the error position and are
 * not empty (cut a), and the same with the here-document bodies and closing delimiter lines of those statements (cut b, when it is longer). Both are returned so a
 * caller can check each: a longer cut that carries a nested syntax error in a body may parse differently from the shorter one. Empty when `cmd` parses, throws, or no statement precedes the error.
 */
export function parseErrorCuts(cmd: string): string[] {
  let script: Script | undefined;
  try {
    script = parse(cmd);
  } catch {
    return [];
  }
  const err = (script as any)?.errors?.[0] as { pos: number } | undefined;
  if (!script || !err) return [];
  let short = 0;
  let long = 0;
  const heredocEnd = (n: SyntaxNode): number => {
    let e = n.type === "HereDoc" ? ((n as any).closing?.end ?? (n as any).body?.end ?? n.end) : 0;
    forEachChild(n, (c) => { e = Math.max(e, heredocEnd(c)); });
    return e;
  };
  for (const st of script.commands) {
    if (st.end > st.pos && st.end <= err.pos) {
      short = Math.max(short, st.end);
      long = Math.max(long, st.end, Math.min(heredocEnd(st), err.pos));
    }
  }
  if (short === 0) return [];
  return long > short ? [cmd.slice(0, short), cmd.slice(0, long)] : [cmd.slice(0, short)];
}

const BODY_NODES = new Set(["Function", "Select", "Coproc", "ArithmeticFor"]);


/** `text` without its closing `done` or `}` and the blanks and `;` around it (what `/[\s;]*(?:\bdone|\})\s*$/` cut, in one pass: that expression backtracks quadratically on a long run of blanks and `;`). */
function stripLoopEnd(text: string): string {
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1]!)) end--;
  if (text[end - 1] === "}") end--;
  else if (text.slice(Math.max(0, end - 4), end) === "done" && (end < 5 || !/\w/.test(text[end - 5]!))) end -= 4;
  else return text;
  while (end > 0 && (text[end - 1] === ";" || /\s/.test(text[end - 1]!))) end--;
  return text.slice(0, end);
}
function ownBody(n: SyntaxNode, cmd: string): string | null {
  const b = BODY_NODES.has(n.type) ? (n as { body?: { pos: number; end: number; type: string } }).body : undefined;
  // a select or arithmetic for body ends before its heredocs: the slice runs to the end of the node, less the closing `done` or `}`
  if (b && typeof b === "object" && b.type !== "Word") return n.type === "Select" || n.type === "ArithmeticFor" ? stripLoopEnd(cmd.slice(b.pos, n.end)) : cmd.slice(b.pos, b.end);
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

/**
 * What the walk of `boundNames` found beyond its result, kept per run unit of the line (see `unitNodes`): the data of `harnessRebound` and of the arithmetic half of
 * `ShellSegment.programUnknown`. `boundNames` itself answers as it always did.
 */
export interface BoundDetail {
  /** Every name the line binds or names (a superset of `BoundNames.names`: also a loop or coproc name and the plain-name words of a loop list), with the first run unit it stands in. */
  names: Map<string, number>;
  /** The first run unit with a site that may bind any name and is not known harmless; Infinity when none. */
  anyFrom: number;
  /** The run units that evaluate arithmetic, a subscript or a computed variable name on a value not shown to be a number. */
  unsafe: Set<number>;
  /** The number of run units. */
  units: number;
}

/** The run units of a line: its statements in order, an `&&` / `||` list split into its commands; a pipeline or a compound command is one unit, with everything nested in it. */
export function unitNodes(script: Script): SyntaxNode[] {
  return script.commands.flatMap((st) => {
    const n: any = st.command;
    return n.type === "AndOr" ? (n.commands as SyntaxNode[]) : [n as SyntaxNode];
  });
}

const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUMBER_ATOM = /^(?:[0-9]+(?:#[0-9A-Za-z]+)?|0[xX][0-9a-fA-F]+)$/;
const SPECIAL_NUMBER = /^\$[?#$!-]$/;

/** How a name is bound: `num` a plain decimal assignment word or an arithmetic assignment, `text` any other assignment, `input` anything else (`read`, `for`, a builtin operand ...). */
interface Binding {
  kind: "num" | "text" | "input";
  /** The literal value of an assignment word. */
  lit: string | null;
}

/** One place the walk found that may bind any name (`any`), evaluate a value as arithmetic (`arith`) or read a variable name from a computed word (`name`); `fires` is read once the line is walked. */
interface BoundSite {
  unit: number;
  seq: number;
  kind: "any" | "arith" | "name";
  fires: () => boolean;
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
  return boundWalk(command).out;
}

/** `boundNames` with the per-unit detail (see `BoundDetail`). */
export function boundNamesDetail(command: string): BoundDetail {
  return boundWalk(command).detail;
}

function boundWalk(command: string): { out: BoundNames; detail: BoundDetail } {
  const out: BoundNames = { names: new Set(), any: false };
  const detail: BoundDetail = { names: new Map(), anyFrom: Infinity, unsafe: new Set(), units: 0 };
  let script: Script | undefined;
  try {
    script = parse(command);
  } catch {
    script = undefined;
  }
  if (!script || (script as any).errors?.length) {
    detail.anyFrom = 0;
    return { out: { names: out.names, any: true }, detail };
  }
  // the run unit being walked, a running number for the order of the sites, and a depth where only the detail is kept (the operands of `let`, read as arithmetic)
  let unit = 0;
  let seq = 0;
  let quiet = 0;
  const sites: BoundSite[] = [];
  const bindings = new Map<string, Binding[]>();
  const expandedAt: Array<{ name: string; unit: number }> = [];
  const markOld = (): void => {
    if (!quiet) out.any = true;
  };
  const site = (kind: BoundSite["kind"], fires: (at: number) => boolean): void => {
    const at = seq++;
    sites.push({ unit, seq: at, kind, fires: () => fires(at) });
  };
  /** A site that may bind any name and is not known harmless. */
  const structural = (): void => {
    markOld();
    site("any", () => true);
  };
  const noteDetail = (n: string): void => {
    if (!detail.names.has(n)) detail.names.set(n, unit);
  };
  const note = (n: string): void => {
    if (!quiet) out.names.add(n);
    noteDetail(n);
  };
  const rec = (n: string, kind: Binding["kind"], lit: string | null = null): void => {
    noteDetail(n);
    // a changed IFS splits the words of a later expansion into other names and paths: from here on any name may be rebound (the detail only; `boundNames` keeps its answer)
    if (n === "IFS" && !quiet) site("any", () => true);
    const l = bindings.get(n);
    if (l) l.push({ kind, lit });
    else bindings.set(n, [{ kind, lit }]);
  };
  // the first site that may bind any name, set once the line is walked: a name is shown to be a number only when none stands before the arithmetic
  let firstAny = Infinity;
  const allNum = (n: string): boolean => !!bindings.get(n)?.length && bindings.get(n)!.every((b) => b.kind === "num");
  /** Shown to be a number: a name of the shell's own counters, or a name with a lowercase letter (bash sets none of those itself) whose every binding on the line is a plain decimal or an arithmetic assignment. */
  const nameShown = (n: string, at: number): boolean => INT_SPECIALS.includes(n) || (/[a-z]/.test(n) && allNum(n) && !(firstAny < at));
  /** Assigned on the line, every time one plain literal name, and no site that may bind any name before. */
  const nameLit = (n: string, at: number): boolean => /[a-z]/.test(n) && !!bindings.get(n)?.length && bindings.get(n)!.every((b) => b.kind !== "input" && b.lit !== null && PLAIN_NAME.test(b.lit)) && !(firstAny < at);
  /** `$((..))` is a number only when no command substitution sits inside it: bash evaluates one there, even in a quoted subscript the walk never enters. */
  const arithExpShown = (p: any): boolean => !/\$\((?!\()|`/.test(String(p.text ?? "`"));
  const atomShown = (text: string, parts: readonly any[] | undefined, at: number): boolean => {
    if (parts?.length === 1 && parts[0].type === "ArithmeticExpansion") return arithExpShown(parts[0]);
    // a lone plain expansion (`$x`, `${x}`, `$?`) is read by its text
    if (parts?.length && !(parts.length === 1 && (parts[0].type === "SimpleExpansion" || (parts[0].type === "ParameterExpansion" && !parts[0].operation && !parts[0].prefix && !parts[0].index)))) return false;
    if (parts?.length) text = String(parts[0].text);
    const t = text.trim();
    if (NUMBER_ATOM.test(t) || SPECIAL_NUMBER.test(t)) return true;
    const m = PLAIN_NAME.test(t) ? t : (/^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(t)?.[1] ?? /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(t)?.[1]);
    return m !== undefined && nameShown(m, at);
  };
  const exprShown = (e: any, at: number): boolean => {
    if (!e) return true;
    if (e.type === "ArithmeticWord") return atomShown(String(e.value ?? ""), e.parts, at);
    if (e.type === "CommandExpansion" || e.type === "ArithmeticCommandExpansion") return false;
    let ok = true;
    forEachChild(e, (c) => {
      if (ok && !exprShown(c, at)) ok = false;
    });
    return ok;
  };
  /** Arithmetic written as text (a `let` operand, a subscript): read by the parser as `(( text ))`. */
  const textShown = (text: string, at: number): boolean => {
    try {
      const p = parse(`(( ${text} ))`) as Script;
      const n: any = p.commands[0]?.command;
      return !p.errors?.length && p.commands.length === 1 && n?.type === "ArithmeticCommand" && n.body === ` ${text} ` && exprShown(n.expression, at);
    } catch {
      return false;
    }
  };
  /** A word read as arithmetic (a `[[ -eq ]]` operand, a slice offset, a subscript). */
  const wordShown = (w: any, at: number): boolean => {
    if (!w) return true;
    let parts = w.parts as any[] | undefined;
    if (parts?.length === 1 && parts[0].type === "DoubleQuoted" && parts[0].parts.length <= 1) parts = parts[0].parts.length ? parts[0].parts : undefined;
    if (!parts) return atomShown(String(w.value ?? w.text ?? ""), undefined, at);
    if (parts.length !== 1) return false;
    const p = parts[0];
    if (p.type === "ArithmeticExpansion") return arithExpShown(p);
    if (p.type === "SimpleExpansion" || p.type === "ParameterExpansion") return !(p.operation || p.prefix || p.index) && atomShown(String(p.text), undefined, at);
    return p.type === "Literal" && atomShown(String(p.value), undefined, at);
  };
  /** The name part of a word (up to its first literal `=`, the whole word when `whole`) holds an expansion, a glob or a brace. */
  const computedName = (w: any, whole = false): boolean => {
    let comp = false;
    let cut = false;
    const go = (parts: readonly any[]): void => {
      for (const p of parts) {
        if (cut) return;
        if (p.type === "DoubleQuoted" || p.type === "LocaleString") go(p.parts);
        else if (p.type === "Literal" || p.type === "SingleQuoted" || p.type === "AnsiCQuoted") {
          if (!whole && String(p.value).includes("=")) cut = true;
        } else comp = true;
      }
    };
    if (w?.parts) go(w.parts);
    return comp;
  };
  /** A word that is exactly `$x` or `"$x"` (never `${!x}`): the name `x`, else undefined. */
  const bareVar = (w: any): string | undefined => {
    let parts = w?.parts as any[] | undefined;
    if (parts?.length === 1 && parts[0].type === "DoubleQuoted" && parts[0].parts.length === 1) parts = parts[0].parts;
    if (parts?.length !== 1) return undefined;
    const p = parts[0];
    if (p.type === "SimpleExpansion") return /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(String(p.text))?.[1];
    return p.type === "ParameterExpansion" && !p.prefix && !p.operation && !p.index && PLAIN_NAME.test(String(p.parameter)) ? String(p.parameter) : undefined;
  };
  /** `w` names a variable (an operand of `declare`, `read`, `unset` ...): a computed word fires unless it is a bare `$x` whose every assignment on the line is one literal plain name. */
  const nameSite = (w: any, whole = false): void => {
    if (!w || w.type !== "Word") return;
    site("name", (at) => {
      if (!computedName(w, whole)) return false;
      const x = bareVar(w);
      return !(x !== undefined && nameLit(x, at));
    });
  };
  /** Arithmetic on text: fires unless every value in it is shown to be a number. */
  const arithSite = (shown: (at: number) => boolean): void => site("arith", (at) => !shown(at));
  /** The arithmetic checks that need the whole line first (`old` is the answer `boundNames` has always given). */
  const lateArith = (old: () => boolean, shown: (at: number) => boolean): void => {
    if (!quiet) late.push(old);
    arithSite(shown);
  };
  const litOf = (w: any): string | null => (w?.type === "Word" && !computedName(w, true) ? String(w.value ?? "") : null);
  /** A word that is one literal plain name (no expansion, no subscript). */
  const plainNameWord = (w: any): boolean => w?.type === "Word" && !computedName(w, true) && PLAIN_NAME.test(String(w.value ?? ""));
  const valNum = (v: any): boolean => (v.type === "Word" ? (DECIMAL.test(String(v.value ?? "")) && !v.parts?.some((p: any) => p.type !== "Literal" && p.type !== "SingleQuoted")) || (v.parts?.length === 1 && v.parts[0].type === "ArithmeticExpansion") : DECIMAL.test(String(v.value ?? "")));
  const valShown = (v: any, at: number): boolean => (v.type === "Word" ? wordShown(v, at) : atomShown(String(v.value ?? ""), undefined, at));
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
  const bind = (n: string, kind: Binding["kind"], lit: string | null = null): void => {
    note(n);
    if (!quiet) assigned.add(n);
    rec(n, kind, lit);
  };
  /** The inner text of the `[..]` subscript after a name character in a word, or null. */
  const subscriptInner = (text: string): string | null => {
    const open = text.search(/[A-Za-z0-9_]\[/) + 1;
    if (open < 1) return null;
    const close = text.lastIndexOf("]");
    return text.slice(open + 1, close > open ? close : undefined);
  };
  /** A word with a `[..]` subscript after a name character whose inner text is not a plain decimal: `test -v` and `declare` evaluate it as arithmetic. */
  const subscriptRisky = (text: string): boolean => {
    const inner = subscriptInner(text);
    return inner !== null && arith(inner, true);
  };
  /** Registers the arithmetic site of a risky subscript, once `subscriptRisky` said so. */
  const subscriptSite = (text: string): void => {
    const inner = subscriptInner(text) ?? "";
    markOld();
    arithSite((at) => textShown(inner, at));
  };
  /**
   * An argument word read raw (text inside single quotes is no expansion): a positional or computed expansion, a command substitution or an unquoted brace expansion
   * (`{a,b}`, `{1..3}`) answers any now; a named one (`$x`, `${x:-..}`, `${!x}`) when the line assigns that name, or when it is joined to a literal that is itself
   * a name (`$unset'HOME'`). `${n:=..}` itself and `$((..))` are read elsewhere.
   */
  let braceSlash = false;
  const expands = (raw: string, word?: any): boolean => {
    braceSlash = false;
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
    if (/(?<!\$)\{[^{}]*(?:,|\.\.)/.test(unquoted)) {
      // a brace list joined to a `/` makes only paths (`$X/{a,b}`): no variant is a variable name, so for D4 it binds nothing
      braceSlash = !!word?.parts?.some((p: any) => p.type === "BraceExpansion") && !!word.parts.some((p: any) => p.type === "Literal" && String(p.value ?? p.text).includes("/"));
      return true;
    }
    const text = live.replace(/\$\(\(.*?\)\)/gs, " ");
    let found = false;
    for (const m of text.matchAll(/\$\{[^}]*\/|\$!|\$\{!([A-Za-z_][A-Za-z0-9_]*)|\$\{?([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_]|:?=)|\$\{?(?=\d|[@*])|\$\((?!\()|`/g)) {
      const n = m[1] ?? m[2];
      if (n === undefined) return true;
      if (!quiet) expanded.add(n);
      expandedAt.push({ name: n, unit });
      found = true;
    }
    // `wait -p ${x:-HOME}`: the default is the name bound when x is unset
    for (const m of plain.matchAll(/\$\{[^}]*?[-+=?]([A-Za-z_][A-Za-z0-9_]*)\}/g)) note(m[1]);
    return found && /^\u0001*(?:-[A-Za-z]+)?\u0001*\w[\w\u0001]*$/.test(text.replace(/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, ""));
  };
  const step = (n: SyntaxNode, depth: number): void => {
    const x = n as any;
    switch (x.type) {
      case "Command": {
        const assigns = [...x.prefix, ...x.suffix].filter((a: any) => a.type === "Assignment");
        for (const a of assigns) {
          const vals: any[] = a.value?.type === "ArrayValue" ? a.value.elements : a.value ? [a.value] : [];
          // `[key]=v` of a compound array: the key is an arithmetic subscript, the value is what is assigned
          const plain = vals.map((v) => (/^\[.*\]=/s.test(wordText(v)) ? { value: wordText(v).replace(/^\[.*?\]=/s, "") } : v));
          const single = a.value?.type === "Word" && !a.append && !a.index && plain.length === 1;
          // an integer name holds a number whatever is assigned (bash evaluates the value; the site below fires when that value is not shown to be a number)
          const intLit = single && ints.has(a.name) && plain[0].type === "Word" && (!plain[0].parts || plain[0].parts.every((q: any) => q.type === "Literal"));
          bind(a.name, single && (valNum(plain[0]) || intLit) ? "num" : "text", single ? litOf(plain[0]) : null);
          if (RUNS_FILE_VARS.has(a.name)) structural();
          for (const v of vals) {
            const key = /^\[(.*?)\]=/s.exec(wordText(v));
            if (key) lateArith(() => arith(key[1], false), (at) => textShown(key[1], at));
          }
          if (plain.some(nonDecimal)) tainted.add(a.name);
          if (!quiet) late.push(() => ints.has(a.name) && plain.some(nonDecimal));
          // an integer name evaluates what is assigned to it as arithmetic
          site("arith", (at) => ints.has(a.name) && !plain.every((v: any) => (intLit ? textShown(String(v.value ?? ""), at) : valShown(v, at))));
          if (a.index) lateArith(() => arith(wordText(a.index), false), (at) => wordShown(a.index, at));
        }
        // a computed program name (`$x ./f`) or a quote-broken assignment word (`HO""ME=/x`, `{HOME,X}=/x`)
        if (x.name && /[$`]/.test(x.name.text)) {
          markOld();
          // a name with no plain last part goes to the judge as an unknown program anyway; one with a plain last part (`$V/bin/pip`) names its program and counts
          site("any", () => lastComponentLiteral(x.name));
        }
        if (x.name && String(x.name.value).includes("=") && !CLEAN_ASSIGN.test(String(x.name.value))) structural();
        const clean = CLEAN_ASSIGN.exec(String(x.name?.value ?? ""));
        if (clean) bind(clean[1], "text");
        const words: string[] = [];
        const raws: string[] = [];
        const nodes: any[] = [];
        for (const w of [x.name, ...x.suffix])
          if (w && w.type === "Word") {
            words.push(String(w.value ?? w.text));
            raws.push(String(w.text ?? w.value));
            nodes.push(w);
          }
        while (words.length && BUILTIN_WRAPPERS.has(baseName(words[0]))) {
          words.shift();
          raws.shift();
          nodes.shift();
        }
        const name = words.length ? baseName(words[0]) : "";
        const args = words.slice(1);
        // an `env` behind another wrapper is read by the walker's `env` case (it sets harnessRebound), not here
        if (name === "env") {
          for (let i = 0; i < args.length; i++) {
            const a = args[i];
            const m = CLEAN_ASSIGN.exec(a);
            if (m) {
              bind(m[1], "text");
              // `env BASH_ENV=x bash -c ..` makes the wrapped shell read a startup file like a prefix assignment does
              if (RUNS_FILE_VARS.has(m[1])) structural();
            } else if (/^-[A-Za-z]*S|^--split-string/.test(a)) structural();
            else if (/^(?:-[A-Za-z]*[uCP]|--unset|--chdir)$/.test(a)) i++;
            else if (!a.startsWith("-")) break;
          }
        }
        // fail closed: a plain argument that is a variable name may be bound by the command (`wait -p N`, `compgen -V N`); a subscript that assigns may bind any name
        // an option with its name attached (`wait -pHOME`) counts too: the tail after the leading letters
        args.forEach((a, i) => {
          if (PLAIN_NAME.test(a)) {
            note(a);
            rec(a, "input");
          }
          if (a.startsWith("-"))
            for (let k = 1; k < a.length; k++) {
              if (PLAIN_NAME.test(a.slice(k))) {
                note(a.slice(k));
                // `-i` is the option itself, `-pHOME` binds HOME
                if (k > 1) rec(a.slice(k), "input");
              }
              if (!/[A-Za-z]/.test(a[k])) break;
            }
          if (subscriptRisky(a)) subscriptSite(a);
          else if (expands(raws[i + 1], nodes[i + 1])) {
            markOld();
            const slash = braceSlash;
            site("any", () => !slash);
          }
        });
        if (DECLARE.has(name) && args.some((a) => /^-[A-Za-z]*i/.test(a))) {
          for (const a of args) if (!a.startsWith("-")) ints.add(/^[A-Za-z_][A-Za-z0-9_]*/.exec(a)?.[0] ?? a);
          for (const a of assigns) ints.add(a.name);
        }
        if ((name === "test" || name === "[") && args.includes("-v")) nameSite(nodes[args.indexOf("-v") + 2]);
        if (BINDS_ANY.has(name)) {
          markOld();
          if (name === "let") {
            // each operand is arithmetic text: a name in it is assigned there, and the operand is a site of its own
            for (const w of nodes.slice(1)) {
              const text = String(w.value ?? w.text);
              arithSite((at) => textShown(text, at));
              quiet++;
              try {
                const p = parse(`(( ${text} ))`) as Script;
                if (!p.errors?.length) for (const st of p.commands) visit(st, depth);
              } catch {
                // an operand that does not parse is not shown to be a number either
              } finally {
                quiet--;
              }
            }
          } else if (name === "eval" || name === "source" || name === "." || name === "trap") structural();
          else {
            // `read`, `mapfile`, `readarray`, `getopts` set the variables they are given: harmless when every one is a literal name (and `mapfile -C` runs no callback)
            const given = nodes.slice(1).filter((w) => !String(w.text).startsWith("-"));
            const targets = name === "getopts" ? given.slice(1, 2) : given;
            const callback = (name === "mapfile" || name === "readarray") && args.some((a) => /^-[A-Za-z]*C/.test(a));
            if (!callback && targets.every(plainNameWord)) {
              for (const w of targets) {
                const t = String(w.value);
                rec(t, "input");
                site("arith", () => ints.has(t));
              }
            } else {
              structural();
              for (const w of targets) nameSite(w);
            }
          }
        } else if (name === "printf" && args.some((a) => /^-[A-Za-z]*v/.test(a))) {
          structural();
          const vi = args.findIndex((a) => /^-[A-Za-z]*v/.test(a));
          const w = /^-[A-Za-z]*v$/.test(args[vi]) ? nodes[vi + 2] : nodes[vi + 1];
          nameSite(w);
          if (plainNameWord(w)) {
            const t = String(w.value);
            rec(t, "input");
            site("arith", () => ints.has(t));
          }
        } else if (DECLARE.has(name) || name === "unset") {
          const nameref = args.some((a) => /^-[A-Za-z]*n/.test(a));
          if (nameref) structural();
          args.forEach((a, i) => {
            const m = CLEAN_ASSIGN.exec(a);
            if (m) bind(m[1], "text");
            else if (PLAIN_NAME.test(a)) bind(a, "input");
            else if (!a.startsWith("-") && !(/^[A-Za-z_][A-Za-z0-9_]*\[[^\]]*\]\+?=/.test(a))) structural();
            if (!a.startsWith("-")) nameSite(nodes[i + 1], nameref);
          });
          // the value of `declare -n r=NAME` is a variable name
          if (nameref) for (const a of assigns) nameSite(a.value, true);
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
            if (script && depth >= MAX_DEPTH) structural();
            else if (script) {
              let inner: Script | undefined;
              try {
                inner = parse(String(w.value));
              } catch {
                inner = undefined;
              }
              if (!inner || (inner as any).errors?.length) structural();
              else for (const st of inner.commands) visit(st, depth + 1);
            }
          });
        }
        break;
      }
      case "For":
      case "Select": {
        markOld();
        // a loop over a literal name binds that name, to the words of its list; the plain-name words of the list are named too, as plain arguments are
        const nm = String(x.name?.value ?? "");
        if (plainNameWord(x.name)) {
          rec(nm, "input");
          site("arith", () => ints.has(nm));
          for (const w of x.wordlist ?? []) if (plainNameWord(w)) rec(String(w.value), "input");
        } else structural();
        break;
      }
      case "Coproc": {
        markOld();
        // the coproc name (default COPROC) is bound to its file descriptors
        rec(x.name?.value ? String(x.name.value) : "COPROC", "input");
        break;
      }
      case "ArithmeticFor":
        markOld();
        arithSite((at) => exprShown(x.initialize, at) && exprShown(x.test, at) && exprShown(x.update, at));
        break;
      case "ArithmeticExpansion":
        lateArith(
          () => arith(String(x.text ?? "").replace(/^\$(?:\(\(|\[)/, "").replace(/(?:\)\)|\])$/, ""), false),
          (at) => exprShown(x.expression, at),
        );
        break;
      case "TestUnary":
        if (subscriptRisky(wordText(x.operand))) subscriptSite(wordText(x.operand));
        else if (expands(String(x.operand?.text ?? wordText(x.operand)))) structural();
        if (x.operator === "-v") nameSite(x.operand);
        break;
      case "TestBinary":
        if (ARITH_TEST_OPS.has(x.operator)) for (const w of [x.left, x.right]) lateArith(() => arith(wordText(w), false), (at) => wordShown(w, at));
        break;
      case "ArithmeticCommand":
        // `(( 1 + 2 ))` binds nothing; a name or an expansion in it may evaluate to an assignment
        if (/[^\s\d+\-*/%()<>=!&|^~?:,]/.test(String(x.body ?? ""))) markOld();
        arithSite((at) => exprShown(x.expression, at));
        break;
      case "FileDescriptorVariable":
        bind(String(x.name), "input");
        break;
      case "ParameterExpansion": {
        const op = x.operation;
        if (x.parameter && (op?.operator === "=" || op?.operator === ":=")) {
          if (x.prefix === "!") structural();
          else bind(x.parameter, "text");
          // `wait -p ${a:=HOME}`: the value is the name the command binds
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(wordText(op.operand))) note(wordText(op.operand));
          if (nonDecimal(op.operand)) tainted.add(x.parameter);
        }
        // a default / assign operand on an integer name and a `${a:off:len}` slice are evaluated as arithmetic, a subscript too
        if (op?.type === "Default" && x.parameter) {
          if (!quiet) late.push(() => ints.has(x.parameter) && nonDecimal(op.operand));
          site("arith", (at) => ints.has(x.parameter) && !wordShown(op.operand, at));
        }
        if (op?.type === "Slice") for (const w of [op.offset, op.length]) if (w) lateArith(() => arith(wordText(w), true), (at) => wordShown(w, at));
        if (x.index) lateArith(() => arith(wordText(x.index), false), (at) => wordShown(x.index, at));
        // `${x@P}` runs the prompt expansion, `${a[S++]}` assigns in its subscript
        if ((op?.type === "Transform" && op.operand?.value === "P") || /[=]|\+\+|--/.test(String(x.index?.value ?? ""))) structural();
        // `${!x}` reads the name `x` holds, which may carry a subscript that runs a command (`${!x*}` and `${!x[@]}` list names)
        if (x.prefix === "!" && x.parameter && op?.type !== "Names" && !x.index) site("name", (at) => !nameLit(String(x.parameter), at));
        break;
      }
      case "ArithmeticBinary":
        if (ARITH_ASSIGN.test(x.operator)) {
          if (x.left?.type === "ArithmeticWord" && PLAIN_NAME.test(String(x.left.value))) bind(String(x.left.value), "num");
          else structural();
        }
        break;
      case "ArithmeticUnary":
        if (x.operator === "++" || x.operator === "--") {
          markOld();
          if (x.operand?.type === "ArithmeticWord" && PLAIN_NAME.test(String(x.operand.value))) rec(String(x.operand.value), "num");
          arithSite((at) => exprShown(x.operand, at));
        }
        break;
    }
  };
  // an explicit stack (the same order as a recursive walk: a node, then its children left to right): a long expression never overflows the call stack
  const visit = (root: SyntaxNode, depth: number): void => {
    const stack: SyntaxNode[] = [root];
    while (stack.length) {
      const n = stack.pop()!;
      step(n, depth);
      const kids: SyntaxNode[] = [];
      forEachChild(n, (c) => {
        kids.push(c);
      });
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
  };
  try {
    const nodes = unitNodes(script);
    detail.units = nodes.length;
    nodes.forEach((u, k) => {
      unit = k;
      visit(u, 0);
    });
    if (late.some((f) => f()) || [...expanded].some((n) => assigned.has(n))) out.any = true;
  } catch (e) {
    // a line too deep for the stack: unreadable, like parseShell's `parse_error`
    if (!(e instanceof RangeError)) throw e;
    out.any = true;
    detail.anyFrom = 0;
  }
  // what is not harmless: a site that may bind any name, an arithmetic or name site not shown safe, an expanded name the line gave text to
  try {
    for (const s of sites) if (s.kind === "any" && s.fires()) firstAny = Math.min(firstAny, s.seq);
    for (const s of sites) {
      if (!s.fires()) continue;
      detail.anyFrom = Math.min(detail.anyFrom, s.unit);
      if (s.kind !== "any") detail.unsafe.add(s.unit);
    }
    for (const e of expandedAt) if (bindings.get(e.name)?.some((b) => b.kind === "text")) detail.anyFrom = Math.min(detail.anyFrom, e.unit);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    out.any = true;
    detail.anyFrom = 0;
  }
  return { out, detail };
}

/** Per line: the harness names rebound per run unit (see `harnessRebound`) and the run units that hold arithmetic not shown safe. */
const analysed = new Map<string, { rebound: string[][]; unsafe: Set<number> }>();

function analyse(command: string): { rebound: string[][]; unsafe: Set<number> } {
  const hit = analysed.get(command);
  if (hit) return hit;
  const d = boundNamesDetail(command);
  // a line that does not parse is one unit that rebinds both names
  const units = Math.max(d.units, 1);
  const rebound = Array.from({ length: units }, (_, k) => HARNESS_NAMES.filter((n) => (d.names.get(n) ?? Infinity) <= k || d.anyFrom <= k));
  const res = { rebound, unsafe: d.unsafe };
  if (analysed.size >= 200) analysed.delete(analysed.keys().next().value as string);
  analysed.set(command, res);
  return res;
}

/**
 * For each run unit of `command` (see `unitNodes`), which of `FOREMAN_SCRATCH` and `FOREMAN_OUT` the line may have rebound in the current shell before or during that unit, so they hold the
 * harness folder only up to the first unit that may change them (fail closed, in run order). A name is in the set from the first unit where `boundNamesDetail` lists it (an assignment,
 * the declare family, `unset`, a `read` or `printf -v` operand, a loop variable, any plain-word argument that is the name ...) or where a site that may bind any name stands and is not known harmless
 * (`eval`, `source`, `printf -v`, a nameref, a computed or expanding argument, a parse failure, arithmetic on a value not shown to be a number, anything the walk adds later).
 */
export function harnessRebound(command: string): string[][] {
  return analyse(command).rebound;
}
