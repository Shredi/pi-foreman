// The shared protected-branch matcher against the table it shares with the sweep's Python test (tests/test_protected_pattern_table.py),
// plus the rows that belong to the TypeScript side alone: the reverse match for a branch containing `*` and the exact-case rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { protectedMatch } from "../protectedmatch.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const CASES: { patterns: string[]; branch: string; expected: boolean }[] = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "..", "tests", "fixtures", "protected-branch-cases.json"), "utf8"));

test("protectedMatch: every row of the shared table, ignoring case", () => {
  assert.ok(CASES.length > 20);
  for (const r of CASES) {
    const got = protectedMatch(r.patterns, r.branch, { ignoreCase: true });
    assert.equal(got !== undefined, r.expected, `${JSON.stringify(r.patterns)} vs ${r.branch}`);
    if (got !== undefined) assert.ok(r.patterns.includes(got));
  }
});

test("protectedMatch: a branch containing `*` also matches an entry it would cover (the guard's reverse match)", () => {
  assert.equal(protectedMatch(["main"], "ma*", { ignoreCase: true }), "main");
  assert.equal(protectedMatch(["release/1.0"], "release/*", { ignoreCase: true }), "release/1.0");
  assert.equal(protectedMatch(["main"], "x*", { ignoreCase: true }), undefined);
  assert.equal(protectedMatch(["main"], "mainline*", { ignoreCase: true }), undefined);
});

test("protectedMatch: exact case compares letter case, ignore case folds both sides", () => {
  assert.equal(protectedMatch(["main"], "Main", { ignoreCase: false }), undefined);
  assert.equal(protectedMatch(["release/*"], "Release/1", { ignoreCase: false }), undefined);
  assert.equal(protectedMatch(["release/*"], "release/1", { ignoreCase: false }), "release/*");
  assert.equal(protectedMatch(["Main"], "main", { ignoreCase: true }), "Main");
});

// Character classes as Python's fnmatch.translate (3.13) builds them; every expected value is the result of fnmatch.fnmatchcase(name, pattern).
const CLASS_ROWS: [string, string, boolean][] = [
  ["release/[z-ab]", "release/b", true],
  ["release/[z-ab]", "release/a", false],
  ["release/[z-ab]", "release/z", false],
  ["release/[z-ab]", "release/c", false],
  ["release/[z-a]", "release/a", false],
  ["release/[z-a]", "release/z", false],
  ["release/[z-a]", "release/", false],
  ["release/[!z-a]", "release/a", true],
  ["release/[!z-a]", "release/z", true],
  ["release/[!z-a]", "release/", false],
  ["release/[!z-a]", "release/ab", false],
  ["[a-cz-x]", "a", true],
  ["[a-cz-x]", "b", true],
  ["[a-cz-x]", "c", true],
  ["[a-cz-x]", "x", false],
  ["[a-cz-x]", "z", false],
  ["[a-cz-x]", "y", false],
  ["[]a]", "]", true],
  ["[]a]", "a", true],
  ["[]a]", "b", false],
  ["[!]a]", "]", false],
  ["[!]a]", "a", false],
  ["[!]a]", "b", true],
  ["[a-]", "a", true],
  ["[a-]", "-", true],
  ["[a-]", "b", false],
  ["[-a]", "a", true],
  ["[-a]", "-", true],
  ["[-a]", "b", false],
  ["[a\\-c]", "a", true],
  ["[a\\-c]", "-", false],
  ["[a\\-c]", "c", true],
  ["[a\\-c]", "b", true],
  ["[a\\-c]", "\\", true],
  ["[a\\]", "a", true],
  ["[a\\]", "\\", true],
  ["rel[ease", "rel[ease", true],
  ["rel[ease", "release", false],
  ["[^a]", "^", true],
  ["[^a]", "a", true],
  ["[^a]", "b", false],
  ["[[]", "[", true],
  ["[[]", "a", false],
];

test("protectedMatch: character classes keep Python's handling of descending ranges, `]`, `-`, `!` and an unclosed `[`", () => {
  for (const [pattern, name, expected] of CLASS_ROWS) {
    assert.equal(protectedMatch([pattern], name, { ignoreCase: false }) !== undefined, expected, `${pattern} vs ${name}`);
  }
});

// Unicode: the expression runs in unicode mode so an astral character is one character, as in Python; every expected value is the result of
// fnmatch.fnmatchcase(name, pattern) under Python 3.13. Literals and class members that are regular-expression syntax (`- / \ ] ^ & ~ #`) stay literal.
const UNICODE_ROWS: [string, string, boolean][] = [
  ["release/?", "release/𝄞", true],
  ["[!a]", "𝄞", true],
  ["[𝄞]", "𝄞", true],
  ["𝄞", "?*?", false],
  ["?*?", "𝄞", false],
  ["[𝄞-𝄞]", "𝄞", true],
  ["[a-𝄞]", "𝄞", true],
  ["[𝄞-a]", "𝄞", false],
  ["[𝄞-𝄞b]", "b", true],
  ["a-b", "a-b", true],
  ["a-b", "axb", false],
  ["[-]", "-", true],
  ["[x-]", "-", true],
  ["[x-]", "x", true],
  ["[!-]", "-", false],
  ["[!-]", "y", true],
  ["a/b", "a/b", true],
  ["a/b", "axb", false],
  ["[/]", "/", true],
  ["[x/]", "/", true],
  ["[x/]", "x", true],
  ["[!/]", "/", false],
  ["[!/]", "y", true],
  ["a\\b", "a\\b", true],
  ["a\\b", "axb", false],
  ["[\\]", "\\", true],
  ["[x\\]", "\\", true],
  ["[x\\]", "x", true],
  ["[!\\]", "\\", false],
  ["[!\\]", "y", true],
  ["a]b", "a]b", true],
  ["a]b", "axb", false],
  ["[]]", "]", true],
  ["[x]]", "]", false],
  ["[x]]", "x", false],
  ["[!]]", "]", false],
  ["[!]]", "y", true],
  ["a^b", "a^b", true],
  ["a^b", "axb", false],
  ["[^]", "^", true],
  ["[x^]", "^", true],
  ["[x^]", "x", true],
  ["[!^]", "^", false],
  ["[!^]", "y", true],
  ["a&b", "a&b", true],
  ["a&b", "axb", false],
  ["[&]", "&", true],
  ["[x&]", "&", true],
  ["[x&]", "x", true],
  ["[!&]", "&", false],
  ["[!&]", "y", true],
  ["a~b", "a~b", true],
  ["a~b", "axb", false],
  ["[~]", "~", true],
  ["[x~]", "~", true],
  ["[x~]", "x", true],
  ["[!~]", "~", false],
  ["[!~]", "y", true],
  ["a#b", "a#b", true],
  ["a#b", "axb", false],
  ["[#]", "#", true],
  ["[x#]", "#", true],
  ["[x#]", "x", true],
  ["[!#]", "#", false],
  ["[!#]", "y", true],
  ["[a-c&&b]", "&", true],
  ["[a-c~~b]", "~", true],
  ["[ ]", " ", true],
  ["[\u0001\u001f]", "\u001f", true],
  ["a\u0001", "a\u0001", true],
];

test("protectedMatch: astral characters, regex-syntax characters and control characters match as in Python (case-sensitive)", () => {
  for (const [pattern, name, expected] of UNICODE_ROWS) {
    assert.equal(protectedMatch([pattern], name, { ignoreCase: false }) !== undefined, expected, `${JSON.stringify(pattern)} vs ${JSON.stringify(name)}`);
  }
});

// Ignoring case: both sides are lowered with toLowerCase (Python's str.lower()) and compared case-sensitively; expected = fnmatchcase(name.lower(), pattern.lower()).
const CASE_ROWS: [string, string, boolean][] = [
  ["i", "İ", false],
  ["İ", "i", false],
  ["İ", "İ", true],
  ["ı", "I", false],
  ["I", "ı", false],
  ["ß", "ẞ", true],
  ["ẞ", "ß", true],
  ["ß", "SS", false],
  ["ss", "ß", false],
  ["σ", "Σ", true],
  ["Σ", "ς", false],
  ["ς", "σ", false],
  ["ς", "Σ", false],
  ["k", "K", true],
  ["K", "k", true],
  ["s", "ſ", false],
  ["ſ", "S", false],
  ["å", "Å", true],
  ["Å", "å", true],
  ["[k]", "K", true],
  ["[a-z]", "K", true],
  ["[a-z]", "ſ", false],
  ["?", "İ", false],
];

test("protectedMatch: ignoring case lowers both sides like Python's str.lower(), with no further Unicode case folding", () => {
  for (const [pattern, name, expected] of CASE_ROWS) {
    assert.equal(protectedMatch([pattern], name, { ignoreCase: true }) !== undefined, expected, `${JSON.stringify(pattern)} vs ${JSON.stringify(name)}`);
  }
});

// Lone surrogates (a high half `\ud83d`, a low half `\ude00`) against Python 3.13: each lone half is its own code point, and two halves made adjacent by a dropped
// descending range stay two. Every expected value is the result of fnmatch.fnmatchcase(name, pattern). No name has a high half directly followed by a low half.
const LONE_ROWS: [string, string, boolean][] = [
  ["[\ud83dz-a\ude00-]", "x", false],
  ["[\ud83dz-a\ude00-\u{e000}]", "x", false],
  ["[\ud83dz-a\ude00]", "\ud83d", true],
  ["[\ud83dz-a\ude00]", "\ude00", true],
  ["[\ud83dz-a\ude00]", "\u{1F600}", false],
  ["[\ud83dz-a\ude00]", "z", false],
  ["\ud83d", "\ud83d", true],
  ["\ud83d", "\ude00", false],
  ["\ud83d", "\u{1F600}", false],
  ["\ude00", "\ude00", true],
  ["\ude00", "\ud83d", false],
  ["\ud83d?", "\ud83dx", true],
  ["\ud83d?", "\ud83d", false],
  ["\ud83d?", "\ud83d\ud83d", true],
  ["\ude00?", "\ude00x", true],
  ["?\ude00", "x\ude00", true],
  ["\ud83d[a]", "\ud83da", true],
  ["\ud83d[a]", "\u{1F600}", false],
  ["\ud83d?\ude00", "\ud83dx\ude00", true],
  ["[\ud83d]", "\ud83d", true],
  ["[\ud83d]", "\ude00", false],
  ["[\ude00]", "\ude00", true],
  ["[\ud83d-\ude00]", "\u{1F600}", false],
  ["[\ud83d-\ude00]", "\ud900", true],
  ["[\ud83d-\ude00]", "a", false],
  ["[a-\ud83d]", "b", true],
  ["[a-\ud83d]", "\ud83d", true],
  ["[\ude00-\ud83d]", "\ude00", false],
  ["[!\ud83d]", "\ud83d", false],
  ["[!\ud83d]", "\ude00", true],
  ["[!\ud83d]", "a", true],
  ["[!\ude00]", "\u{1F600}", true],
  ["[!\ud83dz-a\ude00]", "a", true],
  ["[!\ud83dz-a\ude00]", "\ud83d", false],
];

test("protectedMatch: a lone surrogate stays its own code point, as in Python (literal, under `?`, in a class, as range endpoint, negated)", () => {
  for (const ic of [false, true]) {
    for (const [pattern, name, expected] of LONE_ROWS) {
      assert.equal(protectedMatch([pattern], name, { ignoreCase: ic }) !== undefined, expected, `${JSON.stringify(pattern)} vs ${JSON.stringify(name)} ignoreCase=${ic}`);
    }
  }
});

test("protectedMatch: the reverse match with lone halves in the branch does not throw and agrees with Python", () => {
  // Python: fnmatchcase("main", "*[\ud83dz-a\ude00-]") is False.
  assert.equal(protectedMatch(["main"], "*[\ud83dz-a\ude00-]", { ignoreCase: false }), undefined);
  assert.equal(protectedMatch(["main"], "*[\ud83dz-a\ude00-]", { ignoreCase: true }), undefined);
  // The class ends in a range from the lone low half to U+E000; Python: fnmatchcase("main", branch) and fnmatchcase(branch, "main") are both False.
  assert.equal(protectedMatch(["main"], "*[\ud83dz-a\ude00-\u{e000}]", { ignoreCase: false }), undefined);
  assert.equal(protectedMatch(["main"], "*[\ud83dz-a\ude00-\u{e000}]", { ignoreCase: true }), undefined);
});
