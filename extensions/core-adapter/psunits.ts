// The shell lexer: a shell line split into pipelines, units and words, the command variants of a unit, and the
// script a shell unit carries. floors.ts splits a line of the powershell tool into the units its `bash.deny` patterns are matched against (psUnitTexts).

import { baseName } from "./patternargs.ts";

export interface Parsed {
  pipelines: string[][][];
  /** The operator that ended each pipeline: `&&`, `||`, `&`, `;` (also newline), `(`/`)`, `` ` ``, `{`/`}`, or `end`. */
  seps: string[];
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

const ANSI: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };

/** Body of `$'...'` from `start` (after the quote) -> [decoded text, index of the closing quote]. */
function ansiC(src: string, start: number): [string, number] {
  let out = "";
  let j = start;
  while (j < src.length) {
    const c = src[j];
    if (c === "'") return [out, j];
    if (c === "\\" && j + 1 < src.length) {
      const e = src[j + 1];
      let m: RegExpExecArray | null;
      if (e in ANSI) {
        out += ANSI[e];
        j += 2;
      } else if ((e === "x" || e === "u" || e === "U") && (m = new RegExp(`^[0-9A-Fa-f]{1,${e === "x" ? 2 : e === "u" ? 4 : 8}}`).exec(src.slice(j + 2)))) {
        const cp = parseInt(m[0], 16);
        out += cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
        j += 2 + m[0].length;
      } else if ((m = /^[0-7]{1,3}/.exec(src.slice(j + 1)))) {
        out += String.fromCharCode(parseInt(m[0], 8) & 0xff);
        j += 1 + m[0].length;
      } else if (e === "c" && j + 2 < src.length) {
        out += String.fromCharCode(src.charCodeAt(j + 2) & 0x1f);
        j += 3;
      } else {
        out += "\\" + e;
        j += 2;
      }
      continue;
    }
    out += c;
    j++;
  }
  return [out, src.length];
}

/** Word indices of a parsed unit that are redirect targets (`> f`, `2>> f`, `< f`). */
export const REDIRECTS = new WeakMap<string[], Set<number>>();
/** The subset of REDIRECTS written to (`>`, `>>`, `&>`, `>|`, `>&`), not read from. */
export const WRITE_REDIRECTS = new WeakMap<string[], Set<number>>();
/** Word indices of a parsed unit with a `$` or backtick outside single quotes (the shell may expand it, `${N:=v}` binds N). */
export const LIVE_WORDS = new WeakMap<string[], Set<number>>();
/** Source offsets [start, end) of each word of a parsed unit, in the string given to parseShell. */
export const WORD_SPANS = new WeakMap<string[], Array<[number, number]>>();

/** True when a unit parsed by `parseShell` has a redirect (the operators are dropped from its words). */
export function unitHasRedirect(unit: string[]): boolean {
  return REDIRECTS.has(unit);
}

/** pipelines -> units -> words (quotes removed). */
export function parseShell(src: string, shell: "posix" | "powershell" = "posix"): Parsed {
  const pipelines: string[][][] = [];
  const seps: string[] = [];
  let units: string[][] = [];
  let words: string[] = [];
  let cur: string | null = null;
  let redir = new Set<number>();
  let wredir = new Set<number>();
  let redirNext = false;
  let writeNext = false;
  let pos = 0;
  let wordStart = 0;
  let wordLive = false;
  let spans: Array<[number, number]> = [];
  let live = new Set<number>();
  const flush = (): void => {
    if (cur !== null) {
      if (redirNext) {
        redir.add(words.length);
        if (writeNext) wredir.add(words.length);
      }
      redirNext = false;
      writeNext = false;
      spans.push([wordStart, pos]);
      if (wordLive) live.add(words.length);
      words.push(cur);
    }
    cur = null;
    wordLive = false;
  };
  const endUnit = (): void => {
    flush();
    if (words.length) {
      units.push(words);
      if (redir.size) REDIRECTS.set(words, redir);
      if (wredir.size) WRITE_REDIRECTS.set(words, wredir);
      LIVE_WORDS.set(words, live);
      WORD_SPANS.set(words, spans);
    }
    words = [];
    spans = [];
    live = new Set();
    redir = new Set();
    wredir = new Set();
    redirNext = false;
    writeNext = false;
  };
  const endPipe = (sep: string): void => {
    endUnit();
    if (units.length) {
      pipelines.push(units);
      seps.push(sep);
    }
    units = [];
  };
  const add = (s: string): void => {
    cur = (cur ?? "") + s;
  };
  const posix = shell === "posix";
  let pipeOpen = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    pos = i;
    if (cur === null) wordStart = i;
    if (c !== " " && c !== "\t" && c !== "\r" && c !== "\n" && c !== "|") pipeOpen = false;
    if (c === (posix ? "\\" : "`")) {
      if (src[i + 1] === "\n") i++;
      else if (i + 1 < src.length) add(src[++i]);
    } else if (!posix && c === "\\") add(c);
    else if (posix && c === "$" && src[i + 1] === "'") {
      const [text, end] = ansiC(src, i + 2);
      add(text);
      i = end;
    } else if (posix && c === "$" && src[i + 1] === '"') {
      // $"..." (locale translation): the double-quoted string follows
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? src.length : j;
      add(src.slice(i + 1, end));
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === (posix ? "\\" : "`") && j + 1 < src.length && (posix ? '"\\$`\n'.includes(src[j + 1]) : true)) j++;
        else if (src[j] === "$" || (posix && src[j] === "`")) wordLive = true;
        s += src[j++];
      }
      add(s);
      i = j;
      cur = cur ?? "";
    } else if (c === " " || c === "\t" || c === "\r") flush();
    else if (c === "\n" && pipeOpen && cur === null && words.length === 0) continue; // `a |\nb`: one pipeline
    else if (c === "\n" || c === ";") endPipe(";");
    else if (c === "&" && src[i + 1] === ">" && posix) {
      // `&>file` / `&>>file`: both streams to a file
      flush();
      redirNext = true;
      writeNext = true;
      i++;
      while (src[i + 1] === ">") i++;
    } else if (c === "&") {
      const and = src[i + 1] === "&";
      if (and) i++;
      endPipe(and ? "&&" : "&");
    } else if (c === "|") {
      if (src[i + 1] === "|") {
        i++;
        endPipe("||");
      } else {
        if (src[i + 1] === "&") i++;
        endUnit();
        pipeOpen = true;
      }
    } else if (c === "(" || c === ")" || (posix && c === "`") || (!posix && (c === "{" || c === "}"))) endPipe(c);
    else if (c === "<" || c === ">") {
      if (cur !== null && /^\d+$/.test(cur)) cur = null; // 2>file: the fd number is not a word
      flush();
      redirNext = true;
      writeNext = c === ">";
      while (src[i + 1] === c) i++;
      // `>&2`, `<&-`, `<&3`: an fd dup or close, its operand is no word of the command and `&` is no background operator
      if ((c === ">" || (posix && c === "<")) && src[i + 1] === "&") i++;
      else if (c === ">" && posix && src[i + 1] === "|") i++;
    } else if (c === "#" && cur === null && (i === 0 || /\s|[;&|()]/.test(src[i - 1]))) {
      while (i < src.length && src[i] !== "\n") i++;
      i--;
    } else {
      if (c === "$") wordLive = true;
      add(c);
    }
  }
  pos = src.length;
  endPipe("end");
  return { pipelines, seps, subs: substitutions(src, shell) };
}

export const WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "exec", "nohup", "time", "nice", "ionice", "timeout", "stdbuf", "setsid", "xargs", "watch", "chroot"]);
export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"]);

export const MAX_DEPTH = 4;

/** Reserved words that precede a command (`do cat x`, `then grep y`, `! find`). */
export const LEAD_KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{", "}"]);

/** The unit as written, then with env assignments / wrapper commands / the path prefix stripped; `env` lists the stripped assignments. */
export function variants(words: string[]): { texts: string[]; core: string[]; env: string[] } {
  let w = words.slice();
  const texts: string[] = [];
  const env: string[] = [];
  for (let n = 0; n < 8 && w.length; n++) {
    texts.push(w.join(" "));
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) {
      env.push(w[0]);
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
  return { texts, core: w, env };
}

/** The script a shell-ish unit carries in an argument (`bash -c '...'`, `eval ...`, `pwsh -c ...`). */
export function innerScript(core: string[]): { script: string; shell: "posix" | "powershell" } | null {
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

/**
 * A PowerShell line with an en dash, em dash or horizontal bar (U+2013..U+2015) at the start of a word read as the `-` PowerShell takes
 * it for (`Remove-Item \u2013Recurse`, `Set-Item \u2013Path $p`), so parameter, rule and path checks see the parameter.
 */
export function psDashes(s: string): string {
  return s.replace(/(?<=(?:^|[\s;|({}=,&!])[-\u2013\u2014\u2015]*)[\u2013\u2014\u2015]/g, "-");
}

/** `${env:USERPROFILE}` as `$env:USERPROFILE`: the braces would split the word in the PowerShell parse (same variable). */
export const psProfile = (s: string): string => s.replace(/\$\{env:USERPROFILE\}(?=[\\/])/gi, "$env:USERPROFILE");

/**
 * The texts the old layer matched its `bash.deny` patterns against for a line of the powershell tool (its text part):
 * the line as written and whitespace-collapsed, every pipeline joined, every unit (a leading keyword kept, then the variants: env assignments,
 * wrappers and the path prefix and `.exe` stripped), the units of each `$( )` substitution, the script of each `pwsh -c` / `cmd /c` unit, and
 * the command of a `-exec`.
 */
export function psUnitTexts(rawCommand: string): string[] {
  const command = psDashes(rawCommand);
  const out: string[] = [command.trim(), command.trim().replace(/\s+/g, " ")];
  // as the old collect(): a PowerShell source gets the dash and profile normalisations, a posix script its own rules and none of them;
  // a backtick before CRLF is read as before LF (deliberately stricter than the old layer, which let `gh `<CRLF>auth token` through)
  const collect = (src0: string, shell: "posix" | "powershell", depth: number): void => {
    const src = shell === "powershell" ? psProfile(psDashes(src0)).replace(/`\r\n/g, "`\n") : src0;
    const parsed = parseShell(src, shell);
    for (const inner of parsed.subs) if (depth < MAX_DEPTH) collect(inner, shell, depth + 1);
    const visit = (allWords: string[]): void => {
      let lead = 0;
      while (lead < allWords.length && LEAD_KEYWORDS.has(allWords[lead])) lead++;
      const unitWords = lead ? allWords.slice(lead) : allWords;
      if (lead) out.push(allWords.join(" "));
      const v = variants(unitWords);
      out.push(...v.texts);
      const inner = innerScript(v.core);
      if (inner && depth < MAX_DEPTH) collect(inner.script, inner.shell, depth + 1);
      const exec = v.core.findIndex((x) => x === "-exec" || x === "-execdir" || x === "-ok" || x === "-okdir");
      if (exec >= 0 && depth < MAX_DEPTH) {
        const rest = v.core.slice(exec + 1);
        const end = rest.findIndex((x) => x === ";" || x === "+");
        visit(end >= 0 ? rest.slice(0, end) : rest);
      }
    };
    for (const pipe of parsed.pipelines) {
      out.push(pipe.map((u) => u.join(" ")).join(" | "));
      for (const u of pipe) visit(u);
    }
  };
  collect(command, "powershell", 0);
  return out;
}
