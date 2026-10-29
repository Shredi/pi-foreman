import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathFacts, pathState } from "../pathfact.ts";

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-pathfact-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const wt = path.join(base, "wt");
const other = path.join(base, "other");
const agent = path.join(base, "agent");
const plain = path.join(base, "plain");
for (const d of [wt, path.join(other, "main"), agent, plain]) fs.mkdirSync(d, { recursive: true });
for (const d of [wt, other]) execFileSync("git", ["init", "-q"], { cwd: d, stdio: "ignore" });
fs.writeFileSync(path.join(other, "notes.md"), "n\n");
fs.writeFileSync(path.join(other, "main", "index.ts"), "x\n");
fs.writeFileSync(path.join(wt, "a.txt"), "a\n");

const facts = (tool: string, input: unknown, command = "", owned: string[] = [], agentDir: string | undefined = agent): string[] =>
  pathFacts(tool, input, command, wt, wt, owned, agentDir);

// shell lines carry forward-slash paths (a backslash is an escape in a POSIX shell line); the fact prints the resolved native form
const sh = (p: string): string => p.replace(/\\/g, "/");

test("sibling checkout: read tool and shell read commands", () => {
  assert.deepEqual(facts("read", { path: path.join(other, "main", "index.ts") }), [`path: ${path.join(other, "main", "index.ts")} sibling-checkout`]);
  assert.deepEqual(facts("read", { path: path.join(other, "notes.md") }), [`path: ${path.join(other, "notes.md")} sibling-checkout`]);
  assert.deepEqual(facts("bash", {}, `find ${sh(other)} -maxdepth 2 -name '*.md'`), [`path: ${other} sibling-checkout`]);
  assert.deepEqual(facts("bash", {}, `cat ${sh(other)}/notes.md | wc -l`), [`path: ${path.join(other, "notes.md")} sibling-checkout`]);
});

test("agent dir and plain outside dir", () => {
  assert.equal(facts("ls", { path: agent })[0], `path: ${agent} agent-dir`);
  assert.equal(facts("grep", { pattern: "x", path: plain })[0], `path: ${plain} outside`);
  assert.equal(facts("bash", {}, `ls ${sh(plain)}`)[0], `path: ${plain} outside`);
});

test("owned-root path: no fact", () => {
  assert.deepEqual(facts("read", { path: path.join(wt, "a.txt") }), []);
  assert.deepEqual(facts("bash", {}, "cat a.txt ./a.txt"), []);
  assert.deepEqual(facts("read", { path: path.join(plain, "f") }, "", [plain]), []);
});

test("git failure and non-read commands", () => {
  assert.equal(pathState(path.join(base, "missing", "f"), wt, agent), "outside");
  assert.equal(pathState(plain, wt, agent), "outside");
  assert.deepEqual(facts("bash", {}, `rm ${sh(other)}/notes.md`), []);
  assert.deepEqual(facts("write", { path: path.join(other, "x") }), []);
});
