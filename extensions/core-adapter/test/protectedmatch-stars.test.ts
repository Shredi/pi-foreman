// The shared protected-branch matcher does not backtrack over `*`, and gives the same answer as the one-expression form it replaced (kept below as the
// reference, copied from the matcher as it was: each `*` written as `.*` inside one regular expression).
import { test } from "node:test";
import assert from "node:assert/strict";
import { protectedMatch } from "../protectedmatch.ts";

function refClass(pat: readonly string[], from: number, to: number): string {
  const esc = (s: string) => s.replace(/[\\\-\]\[^]/gu, "\\$&").replace(/\p{Cs}/gu, (h) => `\\u{${h.charCodeAt(0).toString(16)}}`);
  let stuff: string;
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

function refSource(text: string): string {
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
        out += refClass(pat, i + 1, j);
        i = j;
      }
    } else out += c.replace(/[.+^${}()|\\\]/]/gu, "\\$&").replace(/\p{Cs}/gu, (h) => `\\u{${h.charCodeAt(0).toString(16)}}`);
  }
  return out;
}

function refFnmatch(name: string, pattern: string): boolean {
  return new RegExp(`^${refSource(pattern)}$`, "su").test(name);
}

function refMatch(patterns: readonly string[], branch: string, opts: { ignoreCase: boolean }): string | undefined {
  const b = opts.ignoreCase ? branch.toLowerCase() : branch;
  for (const p of patterns) {
    if (typeof p !== "string" || p === "") continue;
    const q = opts.ignoreCase ? p.toLowerCase() : p;
    if (refFnmatch(b, q) || (b.includes("*") && refFnmatch(q, b))) return p;
  }
  return undefined;
}

type Outcome = { v: string | undefined } | { threw: true };
function run(f: typeof protectedMatch, patterns: string[], branch: string, ignoreCase: boolean): Outcome {
  try {
    return { v: f(patterns, branch, { ignoreCase }) };
  } catch {
    return { threw: true };
  }
}

test("protectedMatch: many stars take milliseconds, not seconds", () => {
  const t0 = Date.now();
  assert.equal(protectedMatch(["*a*a*a*a*a*a*a*b"], "a".repeat(60), { ignoreCase: false }), undefined);
  assert.equal(protectedMatch(["*a*a*a*a*a*a*a*b"], "a".repeat(60) + "b", { ignoreCase: false }), "*a*a*a*a*a*a*a*b");
  const twenty = "*a".repeat(20) + "*b";
  assert.equal(protectedMatch([twenty], "a".repeat(2000), { ignoreCase: true }), undefined);
  assert.equal(protectedMatch([twenty], "a".repeat(2000) + "b", { ignoreCase: true }), twenty);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

test("protectedMatch: fixed rows equal the one-expression form", () => {
  const rows: [string, string][] = [
    ["*a", "ba"], ["a*", "ab"], ["*a*", "bab"], ["a**b", "axb"], ["a***b", "ab"], ["a*", "b"],
    ["[*]", "*"], ["[*]", "a"], ["a[*]b", "a*b"], ["a[*]b", "axb"], ["a[*]*b", "a*xb"],
    ["*ab", "abab"], ["*ab", "aba"], ["ab*ba", "aba"], ["ab*ba", "abba"], ["ab*ba", "ababa"],
    ["*", ""], ["*", "x/y"], ["**", "a\nb"], ["a*b", "a\nb"], ["a*b", "a/b"],
    ["", "a"], ["[", "["], ["[*", "[x"], ["*[", "x["], ["[!a]*", "b/c"], ["[]*]", "]"], ["[z-a]*", "b"],
    ["*\u{1F600}", "a\u{1F600}"], ["\u{1F600}*", "\u{1F600}a"], ["?*", "\u{1F600}"], ["*?", "\u{1F600}"], ["?", "\u{1F600}"],
    ["*\ud83d", "a\ud83d"], ["\ude00*", "\ude00a"], ["*\ude00", "😀"], ["*\ud83d*", "x\ud83dy"], ["??", "😀"],
    ["a*b", "a*b"], ["main*", "*"], ["release/*", "release/*"], ["*", "a*"], ["a*b*c", "a*"], ["x*", "x*y"],
  ];
  let n = 0;
  for (const [pat, branch] of rows) {
    for (const ic of [false, true]) {
      assert.deepEqual(run(protectedMatch, [pat], branch, ic), run(refMatch, [pat], branch, ic), `${JSON.stringify(pat)} vs ${JSON.stringify(branch)} ic=${ic}`);
      n++;
    }
  }
  assert.ok(n > 80);
  // The reverse match with a starred branch, and the entry returned is the one configured.
  assert.equal(protectedMatch(["Main", "x"], "m*", { ignoreCase: true }), "Main");
  assert.equal(protectedMatch(["main"], "m*n", { ignoreCase: false }), "main");
  assert.equal(protectedMatch(["main"], "x*", { ignoreCase: false }), undefined);
});

test("protectedMatch: every entry of up to 4 characters against every name of up to 3 equals the one-expression form", () => {
  const alpha = ["*", "?", "[", "]", "!", "-", "a", "b", "/"];
  const names = ["a", "b", "/", "A"];
  const entries: string[] = [];
  const grow = (prefix: string, depth: number) => {
    if (prefix) entries.push(prefix);
    if (depth === 4) return;
    for (const c of alpha) grow(prefix + c, depth + 1);
  };
  grow("", 0);
  const branches: string[] = [""];
  const growB = (prefix: string, depth: number) => {
    if (prefix) branches.push(prefix);
    if (depth === 3) return;
    for (const c of names) growB(prefix + c, depth + 1);
  };
  growB("", 0);
  let pairs = 0;
  let diffs = 0;
  for (const e of entries) {
    for (const b of branches) {
      for (const ic of [false, true]) {
        const a = run(protectedMatch, [e], b, ic);
        const r = run(refMatch, [e], b, ic);
        pairs++;
        if (JSON.stringify(a) !== JSON.stringify(r)) {
          diffs++;
          assert.fail(`${JSON.stringify(e)} vs ${JSON.stringify(b)} ic=${ic}: ${JSON.stringify(a)} != ${JSON.stringify(r)}`);
        }
      }
    }
  }
  assert.equal(diffs, 0);
  console.log(`compared ${pairs} pairs`);
});
