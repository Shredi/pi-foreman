// Ledger 11/12: gate.readTools judges mapped extension tools like read/grep (Read rules, secret-path floors, owned-path allows).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { gateDecide, type GateResult } from "../gate.ts";
import type { GitFacts } from "../defaults.ts";
import type { GateRoots } from "../pathrules.ts";
import type { FloorEnv } from "../floors.ts";
import { parseRule, type RuleSets } from "../rules.ts";
import { readToolsOf, unknownReadTools, warnUnknownReadTools } from "../readtools.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf-readtools-"));
const wt = path.join(base, "wt");
const owned = path.join(base, "owned");
const outside = path.join(base, "outside");
for (const d of [wt, owned, outside]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots: GateRoots = { worktree: wt, scratch: [], tmp: [], owned: [owned], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: false };
const facts: GitFacts = { currentBranch: () => "x", protectedBranches: () => ["main"], pushConfigured: () => false };
const env: FloorEnv = { cwd: wt, home: "/pf/home", agentDir: "/pf/agent", platform: "linux", protectedBranches: ["main"], currentBranch: () => "x", remoteHead: () => "main", writeRoots: [wt] };
const MAP = { ffgrep: "path", fffind: "root", fffmulti: null } as const;

const g = (tool: string, input: Record<string, unknown>, map?: Record<string, string | null>, sets?: RuleSets): GateResult =>
  gateDecide(tool, input, wt, {
    env: () => env,
    roots: () => roots,
    facts,
    ...(map ? { readTools: map } : {}),
    ...(sets ? { rules: { sets, env: { cwd: wt, home: "/pf/home", platform: "linux", checkout: wt } } } : {}),
  });
const rl = (t: string) => {
  const r = parseRule(t);
  assert.ok(r.ok, t);
  return (r as { rule: never }).rule;
};

test("a mapped tool under an owned dir is allowed like read; unmapped keeps today's behaviour", () => {
  const r = g("ffgrep", { pattern: "x", path: owned }, { ...MAP });
  assert.deepEqual(r && "allow" in r ? r.rule : null, "path-read-owned");
  const f = g("fffind", { pattern: "x", root: path.join(owned, "sub") }, { ...MAP });
  assert.ok(f && "allow" in f);
  assert.equal(g("ffgrep", { pattern: "x", path: owned }), undefined);
});

test("a mapped tool outside every root is no allow (falls to review)", () => {
  assert.equal(g("ffgrep", { pattern: "x", path: outside }, { ...MAP }), undefined);
});

test("a null field reads the cwd", () => {
  const r = g("fffmulti", { patterns: ["a"] }, { ...MAP });
  assert.ok(r && "allow" in r && r.rule === "path-read-worktree", JSON.stringify(r));
});

test("a mapped tool pointing at a secret path hits the floor; the search pattern is not floored", () => {
  const r = g("ffgrep", { pattern: "x", path: "/h/me/.ssh/id_rsa" }, { ...MAP });
  assert.ok(r && "block" in r && r.rule === "floor-secret-path");
  const kdbx = g("fffind", { root: "/h/me/vault/secrets.kdbx" }, { ...MAP });
  assert.ok(kdbx && "block" in kdbx);
  const p = g("ffgrep", { pattern: "/h/me/.ssh/id_rsa", path: owned }, { ...MAP });
  assert.ok(p && "allow" in p);
});

test("Read rules cover a mapped tool on its path field", () => {
  const sets: RuleSets = { allow: [], ask: [], deny: [rl(`Read(/${outside}/**)`)] };
  const r = g("ffgrep", { pattern: "x", path: path.join(outside, "a") }, { ...MAP }, sets);
  assert.ok(r && "block" in r, "deny rule applies");
  const none = g("ffgrep", { pattern: "x", path: path.join(outside, "a") }, undefined, sets);
  assert.equal(none, undefined, "unmapped: the Read rule does not cover the tool");
});

test("readToolsOf keeps valid entries only; unknown names are listed and traced once", () => {
  assert.equal(readToolsOf({}), undefined);
  assert.deepEqual(readToolsOf({ gate: { readTools: { ffgrep: "path", bad: 3, "": "x", n: null, e: "" } } }), { ffgrep: "path", n: null });
  const map = { ffgrep: "path", grep: "path" };
  assert.deepEqual(unknownReadTools(map, ["grep", "find"]), ["ffgrep"]);
  const warned = new Set<string>();
  const recs: Record<string, string>[] = [];
  warnUnknownReadTools(map, () => ["grep"], warned, (r) => recs.push(r));
  warnUnknownReadTools(map, () => ["grep"], warned, (r) => recs.push(r));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].names, "ffgrep");
  warnUnknownReadTools(map, () => { throw new Error("no tools"); }, new Set(), (r) => recs.push(r));
  assert.equal(recs.length, 1);
});
