/**
 * The one comparison of a branch against `safety.git.protectedBranches` for every consumer in the adapter (push floor, opaque-text floor, push default,
 * branch-delete default). Python's `fnmatch` semantics (3.13), as the entries were always documented, by code point (the regular expression runs in unicode mode): `*` any run of characters including `/`, `?` one character,
 * `[seq]` and `[!seq]` classes, no special `**`. When the branch itself contains `*` (a wildcard refspec) the entry is also matched as text against the
 * branch taken as the pattern, so a pushed pattern that would cover a protected name counts. The letter-case rule is the caller's: `ignoreCase` lowers both sides with `toLowerCase`, as Python's `str.lower()` does, and compares case-sensitively after that (no regex `i` flag, so no Unicode case folding on top).
 * This agrees with Python 3.13 on every pattern and name, a lone surrogate included: each lone surrogate is written into the regular expression as its own `\u{…}`
 * escape, so two lone halves never join into one astral character there. The differences left: the Unicode version of the lower-casing tables may differ from the
 * Python in use, and a high half directly followed by a low half in the input string itself is one character in JavaScript and two in Python (the two cannot be
 * told apart; a git branch name never holds a lone surrogate).
 * The match does not backtrack over `*`: the entry is cut at each `*` outside a class and each piece is matched on its own at a fixed width (see `fnmatch`), so the
 * time grows with the product of name length and entry length, not exponentially with the number of `*` as one `.*`-joined expression does.
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

/** A run of the entry between two `*`: the JS source of its `fnmatch.translate` and the number of characters (code points) it matches, always exactly that many. */
interface Piece {
  src: string;
  len: number;
}

/**
 * A Python-fnmatch pattern cut at every `*` outside a bracket class (runs of `*` are one cut, empty pieces dropped): the pieces as the `re.translate` of
 * `fnmatch.translate` writes them, without its `(?s:)` wrapper (the caller adds the `s` flag), and whether the entry starts or ends with `*`.
 */
function fnmatchPieces(text: string): { pieces: Piece[]; hasStar: boolean; startStar: boolean; endStar: boolean } {
  const pat = Array.from(text);
  const pieces: Piece[] = [];
  let out = "";
  let len = 0;
  let hasStar = false;
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "*") {
      hasStar = true;
      if (len) pieces.push({ src: out, len });
      out = "";
      len = 0;
      continue;
    }
    len++;
    if (c === "?") out += ".";
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
  if (len) pieces.push({ src: out, len });
  return { pieces, hasStar, startStar: pat[0] === "*", endStar: pat[pat.length - 1] === "*" };
}

/**
 * Whole-string match without backtracking over `*`: every piece has a fixed length, so the first piece is tried at the start (unless the entry begins with `*`),
 * the last at the end (unless it ends with `*`), and each piece between at its earliest position after the one before; the earliest fit never costs a later
 * piece a place. The name is read as code points (`Array.from`, the units the `u` flag sees), and a window of them is joined back for the piece's own
 * expression, so no position falls inside a surrogate pair. Every piece is compiled before the first test, so an entry that cannot be compiled throws as the
 * one-expression form did, whatever the name is, and each caller ends that in a deny.
 */
function fnmatch(name: string, pattern: string): boolean {
  const { pieces, hasStar, startStar, endStar } = fnmatchPieces(pattern);
  const res = pieces.map((p) => new RegExp(`^${p.src}$`, "su"));
  const cps = Array.from(name);
  const at = (k: number, from: number) => res[k].test(cps.slice(from, from + pieces[k].len).join(""));
  if (!hasStar) return pieces.length === 0 ? cps.length === 0 : cps.length === pieces[0].len && at(0, 0);
  let lo = 0;
  let hi = cps.length;
  let first = 0;
  let last = pieces.length - 1;
  if (!startStar) {
    if (pieces[0].len > hi || !at(0, 0)) return false;
    lo = pieces[0].len;
    first = 1;
  }
  if (!endStar) {
    const from = hi - pieces[last].len;
    if (from < lo || !at(last, from)) return false;
    hi = from;
    last--;
  }
  for (let k = first; k <= last; k++) {
    let pos = lo;
    while (pos + pieces[k].len <= hi && !at(k, pos)) pos++;
    if (pos + pieces[k].len > hi) return false;
    lo = pos + pieces[k].len;
  }
  return true;
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
