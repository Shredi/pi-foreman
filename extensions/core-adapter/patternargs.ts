// The pattern and script operands of the read commands (grep, rg, sed, awk, find, echo, printf, git grep / log): the words that are text, never paths.
// Shared by floors.ts and gate.ts.

import { carryFacts, type ShellSegment } from "./shellast.ts";

export const GREP_FAMILY = new Set(["grep", "egrep", "fgrep", "rg"]);

export function baseName(w: string): string {
  const b = w.split(/[\\/]/).pop() ?? w;
  return b.toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
}

/** Short options that take a value, and long ones that take the next word, per read command. */
const VALUE_OPTS: Record<string, { short: string; long: string[]; pattern: string; patternLong: string[]; file: string; fileLong: string[]; globLong?: string[]; globShort?: string }> = {
  grep: { short: "ABCDdefm", long: ["--regexp", "--file", "--after-context", "--before-context", "--context", "--max-count", "--devices", "--directories", "--label", "--binary-files", "--include", "--exclude", "--exclude-dir", "--exclude-from", "--color", "--colour"], pattern: "e", patternLong: ["--regexp"], file: "f", fileLong: ["--file"], globLong: ["--include", "--exclude", "--exclude-dir", "--include-dir"] },
  rg: { short: "ABCEMTdefgjmrt", long: ["--regexp", "--file", "--after-context", "--before-context", "--context", "--max-count", "--max-depth", "--max-columns", "--glob", "--iglob", "--type", "--type-not", "--type-add", "--type-clear", "--replace", "--pre", "--pre-glob", "--encoding", "--threads", "--sort", "--sortr", "--max-filesize", "--colors", "--color", "--path-separator", "--engine", "--ignore-file", "--context-separator", "--field-match-separator", "--field-context-separator", "--dfa-size-limit", "--regex-size-limit", "--hyperlink-format", "--hostname-bin"], pattern: "e", patternLong: ["--regexp"], file: "f", fileLong: ["--file"], globLong: ["--glob", "--iglob"], globShort: "g" },
  sed: { short: "ef", long: ["--expression", "--file", "--line-length"], pattern: "e", patternLong: ["--expression"], file: "f", fileLong: ["--file"] },
  awk: { short: "Fvfeil", long: ["--field-separator", "--assign", "--file", "--source", "--include", "--load"], pattern: "e", patternLong: ["--source"], file: "f", fileLong: ["--file"] },
};
for (const k of ["egrep", "fgrep"]) VALUE_OPTS[k] = VALUE_OPTS.grep;
for (const k of ["gawk", "mawk", "nawk"]) VALUE_OPTS[k] = VALUE_OPTS.awk;

/** A sed script that writes, reads or runs nothing (`w`/`W`/`r`/`R`/`e` commands, the `s///w|e` flags, `a`/`i`/`c` text). */
function sedReadOnly(script: string): boolean {
  let s = script.replace(/\\\n/g, " ");
  s = s.replace(/s(.)((?:\\.|(?!\1).)*)\1((?:\\.|(?!\1).)*)\1([A-Za-z0-9]*)/gs, (_m, _d, _a, _b, flags: string) => (/[we]/.test(flags) ? " w " : ";"));
  s = s.replace(/y(.)((?:\\.|(?!\1).)*)\1((?:\\.|(?!\1).)*)\1/gs, ";");
  s = s.replace(/\/(?:\\.|[^/\\])*\//g, " ").replace(/\\(.)(?:\\.|(?!\1).)*\1/gs, " ");
  return !/[wWrReFaic]/.test(s.replace(/[^A-Za-z]/g, ""));
}

/** An awk program without redirection, pipes, getline or system(). */
function awkReadOnly(prog: string): boolean {
  return !/[<>|]|system|getline|close|fflush/.test(prog);
}

/**
 * Indices (into `core`) of the pattern or script operands of a read command: the grep/rg pattern
 * and `-e` values, the sed script, the awk program, find's -name/-iname/-path/-regex values,
 * every echo/printf argument. `skip` = redirect targets. Files named by `-f` stay paths.
 */
export function nonPathArgs(core: string[], skip: Set<number>): number[] {
  const verb = core.length ? baseName(core[0]) : "";
  const readOnly = (s: string): boolean => (verb === "sed" ? sedReadOnly(s) : verb.endsWith("awk") ? awkReadOnly(s) : true);
  // a script-file or output flag may mis-sort the operands (`awk -F -- --fil=p.awk f`): then every word stays a path
  if ((verb === "sed" || verb.endsWith("awk")) && !unitReadOnly(core, skip)) return [];
  return scriptOperands(core, skip).filter((i) => readOnly(core[i]));
}

/** A `git grep` option cluster with `O` (digits included: `-1Oecho`) or `--open-files-in-pager` by any `--op` prefix. */
export const GIT_GREP_PAGER = /^-[^-]*O|^--op/;

/** nonPathArgs before the read-only filter: every pattern/script operand (and, for grep and rg, the include/exclude/glob values). */
export function scriptOperands(core: string[], skip: Set<number>): number[] {
  if (!core.length) return [];
  const verb = baseName(core[0]);
  const out: number[] = [];
  const ok = (i: number): boolean => !skip.has(i);
  if (verb === "echo" || verb === "printf") return core.map((_, i) => i).filter((i) => i > 0 && ok(i));
  if (verb === "find") {
    if (core.some((x) => /^-(exec|execdir|ok|okdir|delete)$/.test(x))) return [];
    core.forEach((x, i) => {
      if (/^-(name|iname|path|ipath|regex|iregex|wholename|iwholename)$/.test(x) && i + 1 < core.length && ok(i + 1)) out.push(i + 1);
    });
    return out;
  }
  if (verb === "git") {
    // `git grep` takes grep's pattern forms after its global options
    let k = 1;
    while (k < core.length && core[k].startsWith("-")) k += /^-[Cc]$/.test(core[k]) ? 2 : 1;
    if (core[k] === "log") return gitLogPatterns(core, k, skip);
    if (core[k] !== "grep") return [];
    // `-O<cmd>` runs a program on the matched files and mis-sorts the operands (`-Orm x -- F` reads `x` as -m's value, F as the pattern): every word stays a path
    if (core.slice(k).some((a) => GIT_GREP_PAGER.test(a))) return [];
    const rest = core.slice(k);
    return scriptOperands(rest, new Set([...skip].filter((i) => i > k).map((i) => i - k))).map((i) => i + k);
  }
  const spec = VALUE_OPTS[verb];
  if (!spec) return [];
  const grepLike = GREP_FAMILY.has(verb);
  const isRg = verb === "rg";
  if (isRg && core.some((x) => x === "--files" || x === "--type-list")) return [];
  const scripts: number[] = [];
  let given = false;
  let positional = -1;
  let ended = false;
  for (let i = 1; i < core.length; i++) {
    if (!ok(i)) continue;
    const x = core[i];
    if (!ended && x === "--") {
      ended = true;
      continue;
    }
    if (!ended && /^--[^=]/.test(x)) {
      const eq = x.indexOf("=");
      const name = eq > 0 ? x.slice(0, eq) : x;
      const isPat = spec.patternLong.includes(name);
      if (isPat || spec.fileLong.includes(name)) given = true;
      if (spec.globLong?.includes(name)) {
        // a file-name pattern (`--exclude-dir=.git`), never a path
        if (eq > 0) scripts.push(i);
        else if (i + 1 < core.length && ok(i + 1)) scripts.push(i + 1);
      }
      if (eq < 0 && spec.long.includes(name)) {
        // the value of any other option (`--encoding re`, `-A 3`) is no path either; file-reading options keep theirs
        if ((isPat || (grepLike && !PATH_VALUED.test(name))) && i + 1 < core.length && ok(i + 1)) scripts.push(i + 1);
        i++;
      } else if (eq > 0 && isPat) scripts.push(i);
      continue;
    }
    if (!ended && /^-[^-]/.test(x) && !(verb.endsWith("awk") && /^-[0-9]/.test(x))) {
      for (let k = 1; k < x.length; k++) {
        const c = x[k];
        if (!spec.short.includes(c)) continue;
        if (c === spec.pattern || c === spec.file) given = true;
        const isGlob = c === spec.globShort;
        if (k + 1 < x.length) {
          if (c === spec.pattern || isGlob) scripts.push(i);
        } else if (i + 1 < core.length) {
          if ((c === spec.pattern || isGlob || (grepLike && c !== spec.file)) && ok(i + 1)) scripts.push(i + 1);
          i++;
        }
        break;
      }
      continue;
    }
    if (positional < 0) positional = i;
    // awk stops at its program; grep, rg and GNU sed take options after operands too (`grep x f -e y`)
    if (verb.endsWith("awk")) break;
  }
  if (!given && positional > 0) scripts.push(positional);
  return scripts;
}

/** An unknown word: an expansion (`$`, backtick) outside single quotes, or an unquoted tilde. */
const unknownWord = (w: string): boolean => /[$`]/.test(w.replace(/'[^']*'/g, "''")) || w.startsWith("~");
/** A word that is one double-quoted string (`"$PAT"`, `"$(cat p)"`): no word splitting or globbing, so it is exactly one operand. */
const wholeDoubleQuoted = (w: string): boolean => /^"(?:[^"\\]|\\.)*"$/s.test(w);

/**
 * A8: a grep or rg segment whose only unknown words are double-quoted strings (`"$PAT"`, `"$(...)"`) in a pattern position or the value of a non-file
 * option is a read: those words are replaced by a neutral literal and the segment is no longer opaque. An unquoted unknown word, an unknown program,
 * redirect target or path operand, a file option (`-f`), a wrapper and sed/awk (their script text is the pattern position and is unknown) keep the
 * segment as it is. Returns the relaxed segment, or the segment itself when nothing applies.
 */
export function relaxPatternWords<S extends { program: string; argv: string[]; redirects: Array<{ target: string }>; wrappers: string[]; opaque: string | null; heredoc: boolean }>(seg: S): S {
  if (seg.opaque !== "unresolved_var" && seg.opaque !== "glob_target") return seg;
  if (seg.wrappers.length > 0 || seg.heredoc || !GREP_FAMILY.has(seg.program) || unknownWord(seg.program)) return seg;
  if (seg.redirects.some((r) => unknownWord(r.target))) return seg;
  const core = [seg.program, ...seg.argv];
  const slots = new Set(scriptOperands(core, new Set()));
  const argv = [...seg.argv];
  let relaxed = false;
  for (let i = 0; i < argv.length; i++) {
    if (!unknownWord(argv[i])) continue;
    if (!slots.has(i + 1) || !wholeDoubleQuoted(argv[i])) return seg;
    argv[i] = "_";
    relaxed = true;
  }
  if (!relaxed) return seg;
  return carryFacts({ ...seg, argv, opaque: seg.opaque === "glob_target" ? seg.opaque : null }, seg as unknown as ShellSegment);
}

/**
 * R10 item 4: the pickaxe/grep values of `git log` (`-S <string>`, `-G <regex>`, `--grep <pattern>`, their attached forms `-S<s>`, `--grep=<p>`),
 * up to `--`. `-L <range>:<file>` is left out: its <file> part stays a path word.
 */
function gitLogPatterns(core: string[], k: number, skip: Set<number>): number[] {
  const out: number[] = [];
  for (let i = k + 1; i < core.length; i++) {
    const x = core[i];
    if (skip.has(i)) continue;
    if (x === "--") break;
    if ((x === "-S" || x === "-G" || x === "--grep") && i + 1 < core.length) {
      if (!skip.has(i + 1)) out.push(i + 1);
      i++;
    } else if (/^-[SG]./.test(x) || x.startsWith("--grep=")) out.push(i);
  }
  return out;
}

/** Long grep/rg options whose separate value names a file or program: it stays a path word. */
const PATH_VALUED = /^--(file|exclude-from|ignore-file|pre|pre-glob|hostname-bin)$/;

/**
 * Long options each read command may carry and stay read-only. Anything else (an abbreviation such as
 * `--o=` for `--output`, `--in-pl`, `--pr=sh`, or an unknown option) makes the unit not read-only.
 */
const READ_LONG: Record<string, string[]> = {
  sort: "reverse numeric-sort unique ignore-case key field-separator human-numeric-sort month-sort version-sort general-numeric-sort ignore-leading-blanks dictionary-order ignore-nonprinting stable check merge zero-terminated parallel buffer-size temporary-directory random-sort help version".split(" "),
  uniq: "count repeated unique ignore-case skip-fields skip-chars check-chars all-repeated group zero-terminated help version".split(" "),
  sed: "quiet silent expression regexp-extended separate null-data line-length posix debug sandbox unbuffered binary help version".split(" "),
  awk: "assign field-separator posix traditional re-interval sandbox help version".split(" "),
  grep: "recursive dereference-recursive line-number ignore-case no-ignore-case invert-match count files-with-matches files-without-match include exclude exclude-dir regexp fixed-strings extended-regexp basic-regexp perl-regexp word-regexp line-regexp no-filename with-filename only-matching quiet silent max-count context after-context before-context color colour binary-files null text no-messages byte-offset initial-tab binary directories devices help version".split(" "),
  rg: "glob iglob type type-not files files-with-matches files-without-match count count-matches line-number no-line-number ignore-case smart-case case-sensitive hidden no-ignore fixed-strings word-regexp line-regexp invert-match only-matching max-count max-depth context after-context before-context regexp heading no-heading with-filename no-filename follow multiline color json sort sortr threads type-list column pretty vimgrep null text quiet stats no-messages unrestricted glob-case-insensitive pcre2 engine replace trim help version".split(" "),
  find: ["help", "version"],
  diff: "unified context brief recursive ignore-case ignore-space-change ignore-all-space ignore-blank-lines side-by-side new-file text color report-identical-files minimal show-c-function label exclude help version".split(" "),
};

/** Whether one command (wrappers stripped) can only read: no in-place edit, output file, exec or script file. */
export function unitReadOnly(core: string[], skip: Set<number>): boolean {
  const verb = baseName(core[0]);
  const args = core.map((x, i) => (i > 0 && !skip.has(i) ? x : "")).slice(1);
  const has = (re: RegExp): boolean => args.some((x) => re.test(x));
  const longs = READ_LONG[verb.endsWith("awk") ? "awk" : verb];
  if (longs) {
    // never stop at `--`: it can be an option's value (`sort -T -- --o=FILE`)
    for (const x of args) {
      if (/^--./.test(x) && !longs.includes(x.slice(2).split("=")[0])) return false;
    }
  }
  if (verb === "sort") return !has(/^-[A-Za-z]*o|^--(output|compress-program)\b/);
  if (verb === "xxd") {
    // `-r` reverts a dump into a binary and `xxd IN OUT` writes OUT: a read only without -r and with at most one operand (the values of -l -s -c -g -o are no operands)
    if (has(/^-[A-Za-z]*r|^--(revert|r)\b/)) return false;
    return args.filter((x, i) => x && !x.startsWith("-") && !/^-[lscgo]$/.test(args[i - 1] ?? "")).length <= 1;
  }
  if (verb === "find") return !has(/^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/);
  if (verb === "uniq") return !has(/^-[^-]*[^-cdDfisuwz0-9]/) && args.filter((x) => x && (x === "-" || !x.startsWith("-"))).length <= 1;
  if (verb === "rg") return !has(/^--(pre|hostname-bin)\b/);
  if (verb === "sed") {
    // only flag letters and `-e` (BSD `-I`/`-l`, `-i`, `-f` write or take a file); `-l` is no value option, so its script is still checked
    if (args.some((x) => /^-[^-]/.test(x) && !/^-[nErsuze]*$/.test(x))) return false;
    const scripts = scriptOperands(core, skip);
    return scripts.length > 0 && scripts.every((i) => sedReadOnly(core[i]));
  }
  if (verb.endsWith("awk")) {
    if (has(/^-[A-Za-z]*[fEdilop]|^--(f|e|include|load)/)) return false;
    const scripts = scriptOperands(core, skip);
    return scripts.length > 0 && scripts.every((i) => awkReadOnly(core[i]));
  }
  return true;
}
