// find -exec through a shell runner: the inline code is split on shell separators, so a remover joined by `;` or `&&` is still found.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GitFacts } from "../defaults.ts";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf-find-exec-runner-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
fs.mkdirSync(wt, { recursive: true });
fs.mkdirSync(scr, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots: GateRoots = { worktree: wt, scratch: [scr], tmp: [path.join(base, "tmp")], owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: true };
const facts: GitFacts = { currentBranch: () => "feature/x", protectedBranches: () => ["main"], pushConfigured: () => false, hasUpstream: () => false };
const env = baseFloorEnv(wt, { home: path.join(base, "home") });
const dangers = (line: string): string[] => gateEvaluate("bash", { command: line }, wt, { env: () => env, roots: () => roots, facts }).dangers ?? [];

test("find -exec sh -c with a remover after a paren, $(, a backtick or a quote is danger-delete-unknown-target", () => {
  for (const line of [`find . -exec sh -c '(rm -rf x)' \\;`, `find . -exec sh -c 'x=$(rm -rf y)' \\;`, "find . -exec sh -c 'x=`rm -rf y`' \\;", `find . -exec sh -c '"rm" -rf y' \\;`]) {
    assert.ok(dangers(line).includes("danger-delete-unknown-target"), line);
  }
});

test("find -exec sh -c with a remover is danger-delete-unknown-target, also behind ; and &&", () => {
  for (const line of [`find . -exec sh -c 'cd "$1";rm -rf *' _ {} \\;`, `find . -exec sh -c 'true&&rm -rf x' \\;`, `find . -exec sh -c 'rm -rf "$1"' _ {} \\;`]) {
    assert.ok(dangers(line).includes("danger-delete-unknown-target"), line);
  }
});
