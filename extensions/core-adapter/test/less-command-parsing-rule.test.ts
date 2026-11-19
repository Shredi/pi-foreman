import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

test("AGENTS.md carries the default-allow rule for command lines (less-command-parsing, ledger 1)", () => {
  const text = read("AGENTS.md");
  assert.ok(text.includes("Permissions are default allow"));
  assert.ok(text.includes("short fixed list of dangerous commands"));
  assert.ok(text.includes("Pi hook or a structured field"));
  assert.ok(text.includes("no regex over a command line"));
});

test("AGENTS.md widens the rule to text one model writes for another (structured verdicts, D5)", () => {
  const text = read("AGENTS.md");
  assert.ok(text.includes("text one model writes for another (a report, a message, a plan): a gate reads no meaning from it"));
  assert.ok(text.includes("the model gets a tool or a launch field with fields, and models read the prose"));
  assert.ok(text.includes("A heading or file format the harness defines is a format, not meaning"));
});

test("builder and reviewer prompts carry the widened rule (structured verdicts, D5)", () => {
  assert.ok(read("agents/builder.md").includes("text one model writes for another (a report, a message, a plan): code reads no meaning from it, so give the model a tool or a launch field with fields"));
  const reviewer = read("agents/reviewer.md");
  assert.ok(reviewer.includes("findings of kind `now` or `later` stay advisory"));
  assert.ok(reviewer.includes("which are findings of kind `later`"));
});

test("builder role prompt keeps the guard-code rule (less-command-parsing, ledger 2)", () => {
  const text = read("agents/builder.md");
  assert.ok(text.includes("In guard or permission code (code that decides whether an agent's tool call may run)"));
  assert.ok(text.includes("tables that parse command text"));
  assert.ok(text.includes("react through a Pi hook or a structured field"));
});

test("reviewer role prompt flags new command-text parsing in guard code (less-command-parsing, ledger 2)", () => {
  const text = read("agents/reviewer.md");
  assert.ok(text.includes("New guard or permission code in the diff (code that decides whether an agent's tool call may run)"));
  assert.ok(text.includes("parses command text"));
  assert.ok(text.includes("is a defect unless a ledger item asks for it"));
});
