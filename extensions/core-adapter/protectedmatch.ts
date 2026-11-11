/**
 * The one comparison of a branch against `safety.git.protectedBranches` for every consumer in the adapter (push floor, opaque-text floor, push default,
 * branch-delete default). Python's `fnmatch` semantics (3.13), as the entries were always documented, by code point (the regular expression runs in unicode mode): `*` any run of characters including `/`, `?` one character,
 * `[seq]` and `[!seq]` classes, no special `**`. When the branch itself contains `*` (a wildcard refspec) the entry is also matched as text against the
 * branch taken as the pattern, so a pushed pattern that would cover a protected name counts. The letter-case rule is the caller's: `ignoreCase` lowers both sides with `toLowerCase`, as Python's `str.lower()` does, and compares case-sensitively after that (no regex `i` flag, so no Unicode case folding on top).
 * This agrees with Python 3.13 on every pattern and name, a lone surrogate included: each lone surrogate is written into the regular expression as its own `\u{…}`
 * escape, so two lone halves never join into one astral character there. The differences left: the Unicode version of the lower-casing tables may differ from the
 * Python in use, and a high half directly followed by a low half in the input string itself is one character in JavaScript and two in Python (the two cannot be
 * told apart; a git branch name never holds a lone surrogate).
 * A pattern only adds matches: `main`, `master` and the remote's default stay in the list the callers pass.
 *
 * Differences to the sweep's `protected_pattern` (`scripts/foreman_worktree.py`), which means the same fnmatch for the patterns and shares the case table
 * `tests/fixtures/protected-branch-cases.json` with this module:
 *  1. This matcher has the reverse match for a branch containing `*`; the sweep does not (harmless there: a real branch name cannot contain `*`).
 *  2. The gate's floors always protect `main` and `master` (the push floor also the remote's default branch); the sweep's list is the configured one alone
 *     (`main`, `master` only when the key is not a list) and it protects the default branch by its own separate check.
 *  3. The sweep compares default-branch names ignoring case only where the file system does; the push floors ignore case everywhere.
 */

/**
 * The class `pat[from..to)` (between the brackets) as Python's `fnmatch.translate` builds it: split at `-` into chunks, a range whose start is above its end
 * dropped (the rest of the class kept), an empty class never matching, a negated empty class matching any one character.
 */
function fnmatchClass(pat: readonly string[], from: number, to: number): string {
  // Escapes the syntax characters, which stay valid under the `u` flag (an identity escape of anything else would throw there), and writes a lone surrogate as
  // `\u{…}`, so two lone halves made adjacent by a dropped range cannot read as one astral character. Applied per element, never to the joined text.
  const esc = (s: string) => s.replace(/[\\\-\]\[^]/gu, "\\$&").replace(/\p{Cs}/gu, (h) => `\\u{${h.charCodeAt(0).toString(16)}}`);
  let stuff: string;
  // Python indexes by code point; `pat` holds one code point per element, so ranges order by code point.
  const cp = pat.slice(from, to);
  if (!cp.includes("-")) stuff = cp.map(esc).join("");
  else {
    const chunks: string[][] = [];
    let i = 0;
    let k = cp[0] === "!" ? 2 : 1;
    for (;;) {
      k = cp.indexOf("-", k);
      if (k < 0) break;
      chunks.push(cp.slice(i, k));
      i = k + 1;
      k += 3;
    }
    const last = cp.slice(i);
    if (last.length) chunks.push(last);
    else chunks[chunks.length - 1].push("-");
    for (let m = chunks.length - 1; m > 0; m--) {
      if (chunks[m - 1][chunks[m - 1].length - 1].codePointAt(0)! > chunks[m][0].codePointAt(0)!) {
        chunks[m - 1] = chunks[m - 1].slice(0, -1).concat(chunks[m].slice(1));
        chunks.splice(m, 1);
      }
    }
    stuff = chunks.map((c) => c.map(esc).join("")).join("-");
  }
  if (!stuff) return "(?!)";
  if (stuff === "!") return ".";
  return stuff[0] === "!" ? `[^${stuff.slice(1)}]` : `[${stuff}]`;
}

/** The JS source of a Python-fnmatch pattern (the `re.translate` of `fnmatch.translate`, without its `(?s:)` wrapper: the caller adds the `s` flag). */
function fnmatchSource(text: string): string {
  const pat = Array.from(text);
  let out = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "*") out += ".*";
    else if (c === "?") out += ".";
    else if (c === "[") {
      let j = i + 1;
      if (pat[j] === "!") j++;
      if (pat[j] === "]") j++;
      while (j < pat.length && pat[j] !== "]") j++;
      if (j >= pat.length) out += "\\[";
      else {
        out += fnmatchClass(pat, i + 1, j);
        i = j;
      }
    } else out += c.replace(/[.+^${}()|\\\]/]/gu, "\\$&").replace(/\p{Cs}/gu, (h) => `\\u{${h.charCodeAt(0).toString(16)}}`);
  }
  return out;
}

function fnmatch(name: string, pattern: string): boolean {
  return new RegExp(`^${fnmatchSource(pattern)}$`, "su").test(name);
}

/** The entry of `patterns` that `branch` matches (the entry as configured), or undefined. */
export function protectedMatch(patterns: readonly string[], branch: string, opts: { ignoreCase: boolean }): string | undefined {
  const b = opts.ignoreCase ? branch.toLowerCase() : branch;
  for (const p of patterns) {
    if (typeof p !== "string" || p === "") continue;
    const q = opts.ignoreCase ? p.toLowerCase() : p;
    if (fnmatch(b, q) || (b.includes("*") && fnmatch(q, b))) return p;
  }
  return undefined;
}
