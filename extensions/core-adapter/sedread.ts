// Deterministic read-only check for one `sed` unit (a simple command, already split on `;` / `&&`
// by the caller). The permission baseline has no sed rule: sed accepts `w`, `e`, `r` and `s///w`
// with no blank before the file name or command, so no glob can tell a print from a write or an
// exec. This parser allows only print-style scripts and fails closed on everything else:
//   options  -n -E -r -s -u -z (also combined, e.g. -nE), --quiet --silent, -e/--expression SCRIPT
//   script   [addr[,addr2]][!] cmd, separated by `;` or newlines, with { } blocks
//   addr     N, N~S, $, /regex/   addr2 also +N, ~N
//   cmd      p P l = q Q n N d D (l, q, Q with an optional number)
// No s, y, w, W, e, r, R, a, i, c or any other command; no -i, -f, --in-place, --file, and no option after the first operand. Shell
// syntax is limited to bare words, single quotes and double quotes without `$`, backticks or `\`;
// unquoted `$`, globs, redirects, substitutions and the like are refused.

const SHORT_FLAGS = new Set(["n", "E", "r", "s", "u", "z"]);
const LONG_FLAGS = new Set(["--quiet", "--silent", "--regexp-extended", "--separate", "--unbuffered", "--null-data"]);
const BARE = /[A-Za-z0-9_./,:@%+=^-]/;
const COMMANDS = new Set(["p", "P", "l", "=", "q", "Q", "n", "N", "d", "D"]);
const NUMERIC_ARG = new Set(["l", "q", "Q"]);

/** Shell words of `unit`, or null when it holds anything beyond bare words and plain quotes. */
export function shellWords(unit: string): string[] | null {
  const out: string[] = [];
  let cur: string | null = null;
  let i = 0;
  while (i < unit.length) {
    const c = unit[i];
    if (c === " " || c === "\t") {
      if (cur !== null) out.push(cur);
      cur = null;
      i++;
    } else if (c === "'") {
      const end = unit.indexOf("'", i + 1);
      if (end < 0) return null;
      cur = (cur ?? "") + unit.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      const end = unit.indexOf('"', i + 1);
      if (end < 0) return null;
      const body = unit.slice(i + 1, end);
      if (/[$`\\!]/.test(body)) return null;
      cur = (cur ?? "") + body;
      i = end + 1;
    } else if (BARE.test(c)) {
      cur = (cur ?? "") + c;
      i++;
    } else return null;
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** Index just past a `/regex/` that starts at `i` (s[i] === "/"), or -1. Bracket expressions holding `/` or `\` are refused (GNU and BSD read them differently). */
function regexEnd(s: string, i: number): number {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === "\n") return -1;
    if (c === "/") return j + 1;
    if (c === "\\") {
      if (j + 1 >= s.length || s[j + 1] === "\n") return -1;
      j += 2;
    } else if (c === "[") {
      let k = j + 1;
      if (s[k] === "^") k++;
      if (s[k] === "]") k++;
      while (k < s.length && s[k] !== "]") {
        if (s[k] === "/" || s[k] === "\\" || s[k] === "\n") return -1;
        k++;
      }
      if (k >= s.length) return -1;
      j = k + 1;
    } else j++;
  }
  return -1;
}

/** Index past one address at `i` (second address of a range when `second`), or -1 if none parses. */
function addrEnd(s: string, i: number, second: boolean): number {
  const c = s[i];
  if (c === "$") return i + 1;
  if (c === "/") return regexEnd(s, i);
  if (second && (c === "+" || c === "~")) {
    const m = /^\d+/.exec(s.slice(i + 1));
    return m ? i + 1 + m[0].length : -1;
  }
  const m = /^\d+(?:~\d+)?/.exec(s.slice(i));
  return m ? i + m[0].length : -1;
}

/** True when `script` is made only of addresses and the print-style commands above. */
export function readOnlySedScript(script: string): boolean {
  const s = script;
  let i = 0;
  let depth = 0;
  const ws = (): void => {
    while (s[i] === " " || s[i] === "\t") i++;
  };
  for (;;) {
    while (i < s.length && /[\s;]/.test(s[i])) i++;
    if (i >= s.length) return depth === 0;
    if (s[i] === "}") {
      if (--depth < 0) return false;
      i++;
      continue;
    }
    if (/[0-9$/]/.test(s[i])) {
      i = addrEnd(s, i, false);
      if (i < 0) return false;
      if (s[i] === ",") {
        i = addrEnd(s, i + 1, true);
        if (i < 0) return false;
      }
    }
    ws();
    if (s[i] === "!") {
      i++;
      ws();
    }
    const cmd = s[i];
    if (cmd === "{") {
      depth++;
      i++;
      continue;
    }
    if (cmd === undefined || !COMMANDS.has(cmd)) return false;
    i++;
    if (NUMERIC_ARG.has(cmd)) {
      ws();
      while (/[0-9]/.test(s[i] ?? "")) i++;
    }
    ws();
    if (i < s.length && !/[;\n}]/.test(s[i])) return false;
  }
}

/** True when the simple command `unit` is a read-only sed call (see the header). */
export function isReadOnlySed(unit: string): boolean {
  if (/\$\(|`|[<>]/.test(unit)) return false;
  const w = shellWords(unit.trim());
  if (!w || w[0] !== "sed") return false;
  const scripts: string[] = [];
  const positional: string[] = [];
  let opts = true;
  for (let k = 1; k < w.length; k++) {
    const a = w[k];
    if (!opts || a === "-" || !a.startsWith("-")) positional.push(a);
    // GNU sed permutes, BSD sed stops at the first operand: `sed p f -e /x/p` reads /x/p on BSD
    else if (positional.length) return false;
    else if (a === "--") opts = false;
    else if (LONG_FLAGS.has(a)) continue;
    else if (a === "--expression") {
      if (++k >= w.length) return false;
      scripts.push(w[k]);
    } else if (a.startsWith("--expression=")) scripts.push(a.slice("--expression=".length));
    else if (a.startsWith("--")) return false;
    else {
      // short cluster: flags, optionally ending in e with its script attached or following
      let j = 1;
      for (; j < a.length && SHORT_FLAGS.has(a[j]); j++);
      if (j === a.length) continue;
      if (a[j] !== "e") return false;
      if (j + 1 < a.length) scripts.push(a.slice(j + 1));
      else {
        if (++k >= w.length) return false;
        scripts.push(w[k]);
      }
    }
  }
  if (scripts.length === 0) {
    if (positional.length === 0) return false;
    scripts.push(positional[0]);
  }
  return scripts.every(readOnlySedScript);
}
