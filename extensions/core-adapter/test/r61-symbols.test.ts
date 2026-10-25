// Round 61: the dense spinner frames, the `review` icon and the new `wait` glyphs are in every set of the json and of the built-in tables.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { builtinSymbols, symbolSet } from "../symbols.ts";

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "symbols.json");
const FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
const REVIEW = { unicode: "◎", emoji: "🔍", nerd: "\uf002", ascii: "&" };
const WAIT = { unicode: "◷", emoji: "\u23f1\ufe0f", nerd: "\uf017", ascii: "~" };

test("the json and the built-in tables hold 8 dense frames, review and the new wait glyphs", () => {
  const shared = JSON.parse(fs.readFileSync(FILE, "utf8"));
  for (const [tables, label] of [[shared, "json"], [builtinSymbols(), "built-in"]] as const) {
    for (const name of ["unicode", "emoji", "nerd", "ascii"] as const) {
      const set = tables[name];
      assert.deepEqual(set.spinner, name === "ascii" ? ["|", "/", "-", "\\"] : FRAMES, `${label} ${name} spinner`);
      assert.equal(set.review, REVIEW[name], `${label} ${name} review`);
      assert.equal(set.wait, WAIT[name], `${label} ${name} wait`);
    }
  }
  assert.equal(symbolSet("emoji").review, "🔍");
});
