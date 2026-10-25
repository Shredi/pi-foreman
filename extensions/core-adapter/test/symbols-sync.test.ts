// The built-in glyph tables of symbols.ts equal config/symbols.json key for key; the width table knows the PR circles.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { builtinSymbols, cellWidth } from "../symbols.ts";

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "symbols.json");

test("builtinSymbols() equals config/symbols.json key for key", () => {
  const shared = JSON.parse(fs.readFileSync(FILE, "utf8"));
  assert.deepEqual(builtinSymbols(), shared);
});

test("the four PR circles of every set are in the built-in tables", () => {
  const want = { unicode: "●◉○◌", emoji: "●◉○◌", nerd: "\uf111\uf192\uf10c\uf1db", ascii: "x*o." };
  for (const [name, set] of Object.entries(builtinSymbols())) {
    const got = [set["pr-fail"], set["pr-run"], set["pr-ok"], set["pr-none"]].join("");
    assert.equal(got, want[name as keyof typeof want], name);
  }
});

test("cellWidth is 2 for U+1F7E0..U+1F7EB and 1 for the unicode and nerd circles", () => {
  for (let cp = 0x1f7e0; cp <= 0x1f7eb; cp++) assert.equal(cellWidth(cp), 2, cp.toString(16));
  for (const ch of "🔴🟡🟢⚪") assert.equal(cellWidth(ch.codePointAt(0)!), 2, ch);
  for (const ch of "●◉○◌\uf111\uf192\uf10c\uf1db") assert.equal(cellWidth(ch.codePointAt(0)!), 1, ch);
});
