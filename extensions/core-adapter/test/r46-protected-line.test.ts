// R46 item 6: the builder brief's protected-file line names the cited protected files as editable (the task names them) but
// never staged or committed by the child; it no longer says "report the needed change".
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLedgerItems } from "../ledgerblock.ts";

const ledger = "- [ ] 1. do a thing\n";
const brief = (agent: string, task: string): string => {
  const input: Record<string, unknown> = { agent, task };
  applyLedgerItems(input, ledger);
  return input.task as string;
};

test("r46 protected line: a task citing protected files lists them as editable, never staged or committed by the child", () => {
  const b = brief("builder", "implement item 1: add a key to config/foreman.defaults.json and bump package.json");
  assert.ok(!/report the needed change/.test(b), b);
  const line = b.split("\n").find((l) => l.startsWith("Protected files"))!;
  assert.ok(line, b);
  assert.ok(line.includes("config/foreman.defaults.json") && line.includes("package.json"), line);
  assert.ok(!line.includes("config/permissions.baseline.json"), "only the cited files are listed");
  assert.match(line, /you may edit/i);
  assert.match(line, /do not `?git add`? or commit/i);
  assert.match(line, /foreman stages and commits/i);
  assert.match(line, /refused/i);
});

test("r46 protected line: a task citing none gets the stage-and-commit rule only; explorer and reviewer briefs get none", () => {
  const b = brief("builder", "implement the thing");
  const line = b.split("\n").find((l) => l.startsWith("Protected files"))!;
  assert.ok(line, b);
  assert.ok(!/report the needed change/.test(line));
  assert.match(line, /do not stage or commit/i);
  assert.ok(!/you may edit/i.test(line));
  assert.ok(!brief("explorer", "look at package.json").includes("Protected files"));
  assert.ok(!brief("reviewer", "review item 1 package.json").includes("Protected files"));
});
