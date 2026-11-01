/**
 * The one glob matcher of the gate (r79 item 18): a command word is never compiled into a RegExp, so no pattern can stall the gate.
 * `*`, `?`, `[...]` / `[!...]` / `[^...]` with ranges; an unclosed `[` is a literal. Two-pointer star walk, O(n*m), no backtracking blow-up.
 */

/** One element of a glob segment: a literal char, `?`, a bracket class or `*`. */
type GlobTok = { t: "lit"; c: string } | { t: "any" } | { t: "star" } | { t: "cls"; neg: boolean; set: string };

function globToks(seg: string): GlobTok[] {
  const out: GlobTok[] = [];
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "*") {
      if (out[out.length - 1]?.t !== "star") out.push({ t: "star" }); // a run of stars is one star
    } else if (c === "?") out.push({ t: "any" });
    else if (c === "[") {
      let j = i + 1;
      const neg = seg[j] === "!" || seg[j] === "^";
      if (neg) j++;
      const from = j;
      if (seg[j] === "]") j++;
      while (j < seg.length && seg[j] !== "]") j++;
      if (j >= seg.length) out.push({ t: "lit", c });
      else {
        out.push({ t: "cls", neg, set: seg.slice(from, j) });
        i = j;
      }
    } else out.push({ t: "lit", c });
  }
  return out;
}

function inClass(set: string, ch: string): boolean {
  for (let i = 0; i < set.length; i++) {
    if (set[i + 1] === "-" && i + 2 < set.length) {
      if (ch >= set[i] && ch <= set[i + 2]) return true;
      i += 2;
    } else if (set[i] === ch) return true;
  }
  return false;
}

const tokMatch = (k: GlobTok, ch: string): boolean => (k.t === "lit" ? k.c === ch : k.t === "any" ? true : k.t === "cls" ? inClass(k.set, ch) !== k.neg : true);

/** One name against a glob segment (no `/` handling), folded on request. */
export function globSegMatch(pattern: string, name: string, fold = false): boolean {
  const toks = globToks(fold ? pattern.toLowerCase() : pattern);
  const s = fold ? name.toLowerCase() : name;
  let ti = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    const k = toks[ti];
    if (k !== undefined && k.t === "star") {
      star = ti++;
      mark = si;
    } else if (k !== undefined && tokMatch(k, s[si])) {
      ti++;
      si++;
    } else if (star >= 0) {
      ti = star + 1;
      si = ++mark;
    } else return false;
  }
  while (toks[ti]?.t === "star") ti++;
  return ti === toks.length;
}

/** A wildcard (`*` any run including `/`, `?` one char, nothing else special) against a text, folded on request: the rule-pattern semantics, linear. */
export function wildMatch(pattern: string, text: string, fold = false): boolean {
  const p = fold ? pattern.toLowerCase() : pattern;
  const s = fold ? text.toLowerCase() : text;
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (p[pi] === "*") {
      star = pi++;
      mark = si;
    } else if (pi < p.length && (p[pi] === "?" || p[pi] === s[si])) {
      pi++;
      si++;
    } else if (star >= 0) {
      pi = star + 1;
      si = ++mark;
    } else return false;
  }
  while (p[pi] === "*") pi++;
  return pi === p.length;
}

/** A glob against a path: `*`, `?` and classes stay inside one `/` segment. */
export function globMatch(glob: string, text: string, fold = false): boolean {
  const g = glob.split("/");
  const t = text.split("/");
  if (g.length !== t.length) return false;
  return g.every((seg, i) => globSegMatch(seg, t[i], fold));
}
