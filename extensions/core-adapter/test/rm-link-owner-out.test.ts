// A6 guard: a symlink outside the worktree pointing inside it stays a write outside for rm / mv of the link itself (owner session); the final component is never resolved.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { dangerMatch } from "../defaults.ts";
import type { DangerEnv, GitFacts } from "../defaults.ts";
import type { GateRoots } from "../pathrules.ts";
import { parseShell } from "../shellast.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { shPath } from "./_shpath.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync(mkTestTmp("pf-rmlinkown-"));
const wt = path.join(base, "wt");
const outside = path.join(base, "outside");
after(() => fs.rmSync(base, { recursive: true, force: true }));
fs.mkdirSync(path.join(wt, ".git"), { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(wt, "file"), "x\n");
if (posix) fs.symlinkSync(path.join(wt, "file"), path.join(outside, "lnk"));

const roots: GateRoots = { worktree: wt, scratch: [], tmp: [], scratchBase: path.join(base, "s"), owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: false };
const facts: GitFacts = { currentBranch: () => "round/79-x", protectedBranches: () => ["main"], pushConfigured: () => false, hasUpstream: () => false };
const env: DangerEnv = { roots, platform: process.platform, cwd: wt, facts };
const hit = (line: string): string | null => dangerMatch({ tool: "bash", input: { command: line }, text: line, segments: parseShell(line, { cwd: wt }) }, env)?.name ?? null;
const OUT = shPath(outside);

test("owner: rm / mv of an outside link that points into the worktree is a write outside", { skip: !posix }, () => {
  for (const l of [`rm ${OUT}/lnk`, `rm -f ${OUT}/lnk`, `mv ${OUT}/lnk moved`, `mv ${OUT}/lnk ${shPath(wt)}/moved`]) assert.equal(hit(l), "danger-write-outside", l);
});
