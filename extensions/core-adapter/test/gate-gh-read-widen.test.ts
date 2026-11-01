// r79 items 3 and 14: the widened gh/glab read set (search, status, release, label, graphql reads, GET with fields) keeps every write out of default-gh-read.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { dangerMatch } from "../defaults.ts";
import type { DangerEnv, GitFacts } from "../defaults.ts";
import { gateDecide, type GateResult } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import type { FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf79-ghwiden-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
fs.mkdirSync(wt, { recursive: true });
fs.mkdirSync(scr, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots: GateRoots = { worktree: wt, scratch: [scr], tmp: [path.join(base, "tmp")], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: true };
const facts: GitFacts = { currentBranch: () => "round/79-x", protectedBranches: () => ["main"], pushConfigured: () => false };
const env: FloorEnv = { cwd: wt, home: "/pf79/home", agentDir: "/pf79/agent", platform: process.platform, protectedBranches: ["main"], currentBranch: () => "round/79-x", remoteHead: () => "main", writeRoots: [wt, scr] };
const denv: DangerEnv = { roots, platform: process.platform, cwd: wt, facts };
const gate = (line: string): GateResult => gateDecide("bash", { command: line }, wt, { env: () => env, roots: () => roots, facts });
const isDefaultRead = (line: string): boolean => {
  const r = gate(line);
  return !!r && "allow" in r && /default-gh-read/.test(r.rule ?? "");
};
const danger = (line: string): string | null => dangerMatch({ tool: "bash", input: { command: line }, text: line, segments: parseShell(line, { cwd: wt, env: {} }) }, denv)?.name ?? null;

test("the widened reads are default-gh-read", () => {
  for (const l of ["gh search prs x --json number", "gh issue status", "gh release view v1", "gh release list", "gh label list", "glab release list", "glab label list", "gh api graphql -f query='query { viewer { login } }'", "gh api -X GET search/issues -f q=is:pr"]) assert.ok(isDefaultRead(l), l);
});

test("a mutation, subscription, other method, input, header, file or variable query is no default read", () => {
  for (const l of [
    "gh api graphql -f query='mutation { y }'",
    "gh api graphql -f query='MUTATION { y }'",
    "gh api graphql -f query='query { viewer { login } }' -f query='mutation { y }'",
    "gh api graphql -f query='subscription { x }'",
    "gh api graphql -f query=@q.graphql",
    "gh api graphql -f query=$Q",
    "gh api graphql -f query=\"query { $X }\"",
    "gh api graphql",
    "gh api -X POST search/issues -f q=x",
    "gh api search/issues -f q=x",
    "gh api -X GET search/issues -f q=@f",
    "gh api -X GET search/issues --input f",
    "gh api -X GET search/issues -H 'X: y' -f q=x",
    "gh api -X GET search/issues -f 'q=a b'",
    "gh release create v1",
    "gh release upload v1 f",
    "gh label create x",
    "glab label create x",
    "glab release create v1",
    "gh search prs x --jq env",
    "gh search prs x --jq '.[] | input'",
    "gh search prs x --web",
  ]) assert.equal(isDefaultRead(l), false, l);
});

test("the dangerous writes stay danger-forge", () => {
  for (const l of ["gh api graphql -f query='mutation { y }'", "glab api graphql -f query='mutation { y }'", "gh api -X POST search/issues -f q=x", "gh api search/issues -f q=x", "gh release create v1", "gh label create x", "glab label create x", "glab release create v1"]) assert.equal(danger(l), "danger-forge", l);
});
