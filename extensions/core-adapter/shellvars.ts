/**
 * Same-line shell variables for the path checks (`D=<dir>/x; mkdir -p $D`, `mkdir -p $FOREMAN_SCRATCH/x`).
 *
 * A CLOSED GRAMMAR, identical to scripts/shell_write_guard.py (`grammar_statements`) and pinned by
 * tests/fixtures/shellvars-grammar.json. A line resolves `$NAME` / `${NAME}` only when EVERY statement (split on
 * `;`, `&&`, `||`, newline) is either
 *  (a) a sole `NAME=literal`: a plain path (GRAMMAR.literalChars) starting with `/` or a prefix
 *      (`$FOREMAN_SCRATCH`, `$PWD` = the tracked cwd, `$HOME`); NAME (also in a ref) is not reserved (GRAMMAR.reserved / reservedPrefixes); it follows the start, `;`
 *      or a newline, or `&&` after another assignment (a conditional assignment may not run); or
 *  (b) a simple command whose first word is in GRAMMAR.commands and whose other words are plain words
 *      (GRAMMAR.wordChars, `$NAME` / `"$NAME"` / `${NAME}`; a name that is not assigned stays unresolved, `2>&1`, or `>` / `>>` with one plain word).
 *      `cd <literal>` updates the tracked cwd (env.PWD at the start) that `NAME=$PWD` reads.
 * A heredoc opener (`<<NAME`, unquoted, a word of its own) ends the checked text at its line: the statements up to
 *  there resolve, the body and everything after it do not (the class of the line is decided elsewhere, unchanged).
 * Any other line (a pipe, `&`, parentheses, braces, brackets, backtick, `#`, `<`, `$(`, `${` beyond a bare name, a
 * command outside the list) gets NO resolution: today's classification of an unresolved variable.
 * The last assignment wins; only a value starting with `/` (or `$FOREMAN_SCRATCH` from the harness env) is certain.
 */

import * as path from "node:path";

export const GRAMMAR = {
  commands: ["cd", "mkdir", "cp", "mv", "cat", "ls", "tee", "touch", "tar", "node", "npm", "npx", "python3", "git", "test", "echo", "true"],
  wordChars: "A-Za-z0-9/._=:@%+,-", // no `~`: bash never expands a tilde in front of an expansion
  literalChars: "A-Za-z0-9/._-",
  prefixes: ["$FOREMAN_SCRATCH", "$PWD", "$HOME"],
  splitters: [";", "&&", "||", "\n"],
  redirects: ["2>&1", ">/dev/null"],
  redirectOps: [">", ">>"],
  // names (assigned or referenced) that make the whole line resolve nothing; `$FOREMAN_SCRATCH` is the one harness ref
  reserved: ["_", "RANDOM", "SRANDOM", "SECONDS", "LINENO", "PPID", "UID", "EUID", "BASHPID", "GROUPS", "OPTIND", "OPTARG", "PWD", "OLDPWD", "SHLVL", "REPLY", "IFS", "HOME", "PATH", "CDPATH", "ENV", "BASH_ENV"],
  reservedPrefixes: ["BASH_", "FOREMAN_", "GIT_", "NODE_", "NPM_", "LD_", "DYLD_", "SSH_"],
  harnessRefs: ["FOREMAN_SCRATCH"],
  forbidden: ["|", "&", "(", ")", "{", "}", "[", "]", "`", "#", "<", ">", "$(", "${", "\\", "'"],
};

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ASSIGN = new RegExp(`^(${NAME})=((?:${GRAMMAR.prefixes.map(esc).join("|")}|/)[${GRAMMAR.literalChars}]*)$`);
const REF = `\\$(?:\\{(${NAME})\\}|(${NAME}))`;
const WORD = new RegExp(`^(?:[${GRAMMAR.wordChars}]|${REF})+$`);
const HEREDOC_WORD = /^<<[A-Za-z_][A-Za-z0-9_]*$/;
const SPLIT = new RegExp(`(${GRAMMAR.splitters.map(esc).join("|")})`);

/** False for a special, readonly or sensitive variable name (a ref may name the harness's FOREMAN_SCRATCH). */
function nameOk(name: string, ref = false): boolean {
  if (ref && GRAMMAR.harnessRefs.includes(name)) return true;
  return !GRAMMAR.reserved.includes(name) && !GRAMMAR.reservedPrefixes.some((p) => name.startsWith(p));
}

/** The statements of `text` (`[name, rawValue]` for an assignment, null for a command) when all are inside the grammar, else null. */
export function grammarStatements(text: string): Array<[string, string] | null> | null {
  const parts = text.split(SPLIT);
  const stmts = parts.filter((_, i) => i % 2 === 0);
  const seps = parts.filter((_, i) => i % 2 === 1);
  const out: Array<[string, string] | null> = [];
  let prevAssign = false;
  for (let i = 0; i < stmts.length; i++) {
    const before = i > 0 ? seps[i - 1] : null;
    const after = i < seps.length ? seps[i] : null;
    const stmt = stmts[i].replace(/^[ \t]+|[ \t]+$/g, "");
    if (!stmt) {
      if (i > 0 && i < stmts.length - 1 && !((before === ";" || before === "\n") && (after === ";" || after === "\n"))) return null;
      continue;
    }
    const words = stmt.split(/[ \t]+/);
    const m = stmt.match(ASSIGN);
    if (m) {
      // a conditional assignment (`test -f x && D=/a`, `cmd || D=/a`) may not run: not a statement of its own
      const joined = before === null || before === ";" || before === "\n" || (before === "&&" && prevAssign);
      if (!nameOk(m[1]) || !joined) return null;
      out.push([m[1], m[2]]);
      prevAssign = true;
      continue;
    }
    prevAssign = false;
    if (!GRAMMAR.commands.includes(words[0])) return null;
    let want = false; // a lone `>` / `>>` wants its target as the next word
    for (let w of words.slice(1)) {
      if (GRAMMAR.redirects.includes(w) || HEREDOC_WORD.test(w)) continue;
      if (!want && GRAMMAR.redirectOps.includes(w)) {
        want = true;
        continue;
      }
      want = false;
      for (const op of [">>", ">"]) {
        if (w.startsWith(op)) {
          w = w.slice(op.length);
          break;
        }
      }
      if (w.length >= 2 && w.startsWith('"') && w.endsWith('"')) w = w.slice(1, -1);
      if (!WORD.test(w)) return null;
      for (const r of w.matchAll(new RegExp(REF, "g"))) if (!nameOk((r[1] ?? r[2])!, true)) return null;
    }
    if (want) return null;
    out.push(null);
  }
  return out;
}

/** The certain value of an assignment literal, else undefined. `cwd` is the tracked directory `$PWD` stands for. */
function certain(raw: string, env: Record<string, string>, cwd: string | undefined): string | undefined {
  if (raw.startsWith("/")) return raw;
  for (const [p, base] of [["$FOREMAN_SCRATCH", env.FOREMAN_SCRATCH], ["$PWD", cwd]] as const) {
    const rest = raw.slice(p.length);
    if (raw.startsWith(p) && (rest === "" || rest.startsWith("/")) && base && base.startsWith("/")) return base + rest;
  }
  return undefined;
}

/** The text up to the end of the line holding the first heredoc opener (the whole text without one). */
function headerOf(text: string): string {
  const at = text.indexOf("<<");
  if (at < 0) return text;
  const nl = text.indexOf("\n", at);
  return nl < 0 ? text : text.slice(0, nl);
}

/** The directory after `cd <literal>` (words already substituted); undefined when it is not certain. */
function cdTarget(words: string[], cwd: string | undefined): string | undefined {
  if (words.length !== 2 || words[1].startsWith("-") || words[1].includes("$")) return undefined;
  if (words[1].startsWith("/")) return path.posix.normalize(words[1]);
  return cwd ? path.posix.join(cwd, words[1]) : undefined;
}

/**
 * The resolvable `$NAME` / `${NAME}` inside the words of `pipelines`, replaced by their values. Returns, for each unit
 * with a change, a same-length copy of its words (keyed by the original array, which stays untouched: the read-only
 * and redirect bookkeeping keeps seeing the variable). `seps[i]` is the operator that ended pipeline `i`;
 * `redirected(unit)` says whether a unit carries a redirect. `src` is the line as written; without it the line is
 * rebuilt from the words (a unit with a redirect then gets no resolution).
 */
export function resolveVars(pipelines: string[][][], seps: string[], env: Record<string, string>, redirected: (unit: string[]) => boolean = () => false, src?: string): Map<string[], string[]> {
  const none = new Map<string[], string[]>();
  let text = src;
  if (text === undefined) {
    if (pipelines.some((p) => p.some((u) => redirected(u)))) return none;
    const sepText = (s: string): string => (s === ";" ? "; " : s === "&&" || s === "||" ? ` ${s} ` : s === "end" ? "" : s);
    text = pipelines.map((p, i) => p.map((u) => u.join(" ")).join(" | ") + sepText(seps[i] ?? "end")).join("");
  }
  const header = headerOf(text);
  const stmts = grammarStatements(header);
  if (!stmts || (header === text ? stmts.length !== pipelines.length : stmts.length > pipelines.length)) return none;
  let cwd: string | undefined = env.PWD;
  const values = new Map<string, string>();
  const out = new Map<string[], string[]>();
  const subst = (w: string): string =>
    w.replace(new RegExp(REF, "g"), (m, a: string | undefined, b: string | undefined) => {
      const n = (a ?? b)!;
      const v = values.get(n) ?? (n.startsWith("FOREMAN_") ? env[n] : undefined);
      return v === undefined || v === "" ? m : v;
    });
  pipelines.slice(0, stmts.length).forEach((pipe, i) => {
    const a = stmts[i];
    if (a) {
      const v = certain(a[1], env, cwd);
      if (v === undefined) values.delete(a[0]);
      else values.set(a[0], v);
      return;
    }
    for (const unit of pipe) {
      const next = unit.map(subst);
      if (next.some((x, k) => x !== unit[k])) out.set(unit, next);
      if (unit[0] === "cd") cwd = cdTarget(next, cwd);
    }
  });
  return out;
}
