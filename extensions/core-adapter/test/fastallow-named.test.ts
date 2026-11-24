// D2 named conditions of the fast allow: a program that reads but can write or run code is no default-read; `S=$FOREMAN_SCRATCH` binds own scratch only;
// the pacman query forms are no danger-install.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { JUDGE_FIRST, lineDefault } from "../defaults.ts";
import type { DefaultCtx, GitFacts } from "../defaults.ts";
import type { GateRoots } from "../pathrules.ts";
import { parseShell } from "../shellast.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";
import { gateOracle, makeLayout } from "./_gate-gen.ts";

const base = fs.realpathSync(mkTestTmp("fastallow-named-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
for (const d of [wt, scr]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots: GateRoots = { worktree: wt, scratch: [scr], tmp: [path.join(base, "tmp"), "/tmp"], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: true };
const facts: GitFacts = { currentBranch: () => "round/x", protectedBranches: () => ["main"], pushConfigured: () => false, hasUpstream: () => false };
const ctx: DefaultCtx = { roots, facts, platform: process.platform, cwd: wt };
const dflt = (line: string): string | null => lineDefault(line, parseShell(line, { cwd: wt, env: { FOREMAN_SCRATCH: scr } }), ctx);

test("sed: a read-looking line with a w command is no default-read; the plain print is", { skip: posixOnly }, () => {
  for (const l of ["sed -n 'w /etc/x' a.ts", "sed -n '1w /tmp/zz' a.ts", "sed -n '$w /tmp/zz' a.ts", "sed -n '/re/w out.txt' a.ts", "sed w/etc/x a.ts"]) assert.equal(dflt(l), null, l);
  for (const l of ["sed -n 1p a.ts", "sed -n 2,4p a.ts"]) assert.equal(dflt(l), "default-read", l);
});

test("sed: a w command to a file outside the own folders is refused for a child, whatever the address", { skip: posixOnly }, () => {
  const oracle = gateOracle(makeLayout(path.join(base, "gate")));
  for (const l of ["sed -n '1w /opt/zz' a.ts", "sed -n '$w /opt/zz' a.ts", "sed -n '/re/w /opt/zz' a.ts"]) {
    for (const role of ["builder", "reviewer"] as const) assert.equal(oracle(l, role), "block", `${role}: ${l}`);
  }
  for (const l of ["sed -n 1,3p a.ts", "sed -n 's/a/b w/p' a.ts"]) assert.equal(oracle(l, "builder"), "silent", l);
});

test("rg: --pre runs a program, so the line is no default-read; a plain search is", { skip: posixOnly }, () => {
  for (const l of ["rg --pre ./evil.sh foo", "rg --pre=./evil.sh foo", "rg --pre-glob '*.x' foo"]) assert.equal(dflt(l), null, l);
  assert.equal(dflt("rg foo"), "default-read");
});

test("S=$FOREMAN_SCRATCH binds own scratch: a write below $S runs; any other binding or escape does not", { skip: posixOnly }, () => {
  assert.ok(dflt("S=$FOREMAN_SCRATCH; echo x > $S/x"), "own scratch");
  assert.ok(dflt("S=$FOREMAN_SCRATCH; echo x > $S/sub/x"), "below own scratch");
  assert.ok(dflt("S=$FOREMAN_SCRATCH; cat $S/x"));
  for (const l of ["S=/etc; echo x > $S/x", "S=$HOME; echo x > $S/x", "FOREMAN_SCRATCH=~/x; S=$FOREMAN_SCRATCH; echo x > $S/x", "S=$FOREMAN_SCRATCH; echo x > $S/../x", "S=$FOREMAN_SCRATCH; S=/etc; echo x > $S/x"]) {
    assert.equal(dflt(l), null, l);
  }
});

test("danger-install: the pacman query forms are unlabelled, the install and remove forms are labelled", { skip: posixOnly }, () => {
  const rule = JUDGE_FIRST.find((r) => r.name === "danger-install")!;
  const denv = { roots, platform: process.platform, cwd: wt, facts };
  const hit = (line: string): boolean => rule.test({ tool: "bash", input: { command: line }, text: line, segments: parseShell(line, { cwd: wt, env: { FOREMAN_SCRATCH: scr } }) }, denv);
  for (const l of ["pacman -Ss x", "pacman -Si x", "pacman -Sl", "pacman -Sg"]) assert.equal(hit(l), false, l);
  for (const l of ["pacman -S x", "pacman -Syu", "pacman -Rns x"]) assert.equal(hit(l), true, l);
});
