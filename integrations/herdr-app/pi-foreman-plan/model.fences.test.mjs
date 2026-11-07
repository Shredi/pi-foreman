import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { toLines, splitBlocks, fenceInfo, sha256, fenceLang, validateSvg, checkDiagrams, cachePath, sanitize } from "./model.js";

const fixture = JSON.parse(readFileSync(new URL("../../../tests/fixtures/mermaid-fences.json", import.meta.url), "utf8"));

const fencesOf = (md) => {
  const lines = toLines(md);
  return splitBlocks(lines).filter((b) => b.kind === "fence").map((b) => fenceInfo(lines, b)).filter((f) => f.mermaid).map((f) => ({ text: f.text, sha: f.sha }));
};

for (const c of fixture.cases) {
  test(`fence rule vector: ${c.name}`, () => {
    assert.deepEqual(fencesOf(c.markdown), c.fences);
  });
}

test("sha256 matches node:crypto, including multi-byte text and block boundaries", () => {
  for (const s of ["", "abc", "A", "ä€😀", "x".repeat(55), "x".repeat(56), "x".repeat(64), "x".repeat(1000), "a\nb\r\nc"]) {
    assert.equal(sha256(s), createHash("sha256").update(s, "utf8").digest("hex"), JSON.stringify(s.slice(0, 20)));
  }
});

test("CRLF text hashes like its LF form", () => {
  assert.deepEqual(fencesOf("```mermaid\r\nA-->B\r\n```\r\n"), fencesOf("```mermaid\nA-->B\n```\n"));
});

test("flatten invariant: sanitize leaves a mermaid fence's text untouched", () => {
  const md = "text <b>x</b>\n\n```mermaid\nA[\"<b>x</b>\"]-->B\n```\n";
  assert.deepEqual(fencesOf(sanitize(md)).map((f) => f.sha), fencesOf(md).map((f) => f.sha));
});

test("fenceLang: aliases, plain, bad words", () => {
  assert.equal(fenceLang("ts"), "typescript");
  assert.equal(fenceLang("JSON title=x"), "json");
  assert.equal(fenceLang(""), "");
  assert.equal(fenceLang("../x"), "");
});

test("validateSvg: allowed and refused", () => {
  assert.equal(validateSvg('<svg width="10" height="10"><rect x="0"/><text>a</text></svg>'), null);
  assert.equal(validateSvg('<svg><marker id="m"/><path marker-end="url(#m)"/></svg>'), null);
  assert.equal(validateSvg("<svg><script>1</script></svg>"), "active_content");
  assert.equal(validateSvg('<svg><image href="x"/></svg>'), "href");
  assert.equal(validateSvg('<svg onload="x"></svg>'), "event_attribute");
  assert.equal(validateSvg('<svg><rect fill="url(http://x)"/></svg>'), "url");
  assert.equal(validateSvg("<svg><style>a{}</style></svg>"), "element:style");
  assert.equal(validateSvg("<html></html>"), "not_svg");
});

test("checkDiagrams and cachePath refuse anything but sha and theme names", () => {
  const sha = "a".repeat(64);
  assert.equal(checkDiagrams([{ sha, dark: `diagrams/${sha}-dark.svg`, light: `diagrams/${sha}-light.svg` }]).length, 1);
  assert.equal(checkDiagrams([{ sha, dark: "../../etc/passwd", light: `diagrams/${sha}-light.svg` }]).length, 0);
  assert.equal(checkDiagrams([{ sha: "../x", dark: "a", light: "b" }]).length, 0);
  assert.equal(cachePath(sha, "dark"), `mods/pi-foreman-plan/cache/${sha}-dark.svg`);
  assert.equal(cachePath("../x", "dark"), null);
  assert.equal(cachePath(sha, "../dark"), null);
});
