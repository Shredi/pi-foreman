import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sanitize } from "./model.js";
import * as mine from "./model.js";
import * as agents from "../pi-foreman/model.js";

test("<mark> becomes bold, any case, attributes dropped", () => {
  assert.equal(sanitize("a <mark>b</mark> c"), "a **b** c");
  assert.equal(sanitize('<MARK class="x" style="color:red">m</Mark>'), "**m**");
});

test("<mark> inside a fence or an inline code span stays literal", () => {
  assert.equal(sanitize("```\n<mark>x</mark>\n```"), "```\n<mark>x</mark>\n```");
  assert.equal(sanitize("see `<mark>x</mark>` here"), "see `<mark>x</mark>` here");
});

test("nested or unbalanced <mark> does not throw and leaves balanced bold", () => {
  assert.equal(sanitize("<mark>a <mark>b</mark> c</mark>"), "**a b c**");
  assert.equal(sanitize("a</mark>b"), "ab");
  assert.equal(sanitize("<mark>open\nnext line"), "**open**\nnext line");
  assert.equal(sanitize("<mark>a `c` b</mark>"), "**a `c` b**");
});

test("the shared helpers still match the Agents mod", () => {
  for (const name of ["isSafeHttpsUrl", "openerArgv", "buildTree", "allSessions", "joinAgents", "joinPath", "fmtSince"]) {
    assert.equal(String(mine[name]), String(agents[name]));
  }
  assert.ok(readFileSync(new URL("./model.js", import.meta.url), "utf8").length > 0);
});
