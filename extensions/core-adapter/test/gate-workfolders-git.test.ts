// PR5 review 1: work folders relax reads only. Git write defaults keep their cwd rule in a repo inside a folder; shell reads stay built-in; guarded roots count in both spellings.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { gateEvaluate, type GateOutcome } from "../gate.ts";
import type { GitFacts } from "../defaults.ts";
import { folderProtected, workFolderOf } from "../pathrules.ts";
import type { GateRoots } from "../pathrules.ts";
import type { FloorEnv } from "../floors.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { shPath } from "./_shpath.ts";

const base = fs.realpathSync(mkTestTmp("pf-wfg-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const tmpDir = path.join(base, "tmp");
const work = path.join(base, "work");
const repo = path.join(work, "repo");
const realPkg = path.join(base, "real", "pkg");
const linkPkg = path.join(base, "nm", "pkg");
for (const d of [wt, scr, path.join(repo, ".git"), path.join(realPkg, "extensions"), path.dirname(linkPkg)]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(work, "x"), "x\n");
fs.symlinkSync(realPkg, linkPkg);
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (o: Partial<GateRoots> = {}): GateRoots => ({
  worktree: wt, scratch: [scr], tmp: [tmpDir, "/tmp"], scratchBase: path.join(tmpDir, "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [],
  child: false, role: "foreman", tmpAccess: true, agentDir: path.join(base, "agent"), pkgRoot: path.join(base, "pkg-none"), workFolders: [{ path: work, mode: "auto" }], ...o,
});
const facts: GitFacts = { currentBranch: () => "round/x", protectedBranches: () => ["main"], pushConfigured: () => false, hasUpstream: () => false, ownBranches: () => ["round/x"] };
const env: FloorEnv = { cwd: wt, home: "/pf-wfg/home", agentDir: "/pf-wfg/agent", platform: process.platform, protectedBranches: ["main"], currentBranch: () => "round/x", remoteHead: () => "main", writeRoots: [wt, scr, tmpDir, "/tmp"] };
const sh = (line: string, r: GateRoots): GateOutcome => gateEvaluate("bash", { command: line }, wt, { env: () => env, roots: () => r, facts });
const rule = (o: GateOutcome): string | null => (o.result && "allow" in o.result ? o.result.rule : null);
const shape = (o: GateOutcome): string => JSON.stringify({ d: o.danger?.name ?? null, r: o.result });

const none = roots({ workFolders: [] });
const GIT = ["git commit -m x", "git add -A", "git push origin HEAD", "git pull --ff-only"];

for (const mode of ["read", "auto"] as const) {
  test(`git writes in a repo inside a ${mode} folder keep the no-folder result`, () => {
    const r = roots({ workFolders: [{ path: work, mode }] });
    for (const g of GIT) {
      const line = `cd ${shPath(repo)} && ${g}`;
      const o = sh(line, r);
      assert.ok(!/default-git/.test(rule(o) ?? ""), `${line}: ${shape(o)}`);
      assert.equal(o.danger?.name, sh(line, none).danger?.name, line);
    }
  });
}

test("shell reads in a folder stay built-in", () => {
  for (const mode of ["read", "auto"] as const) {
    const r = roots({ workFolders: [{ path: work, mode }] });
    assert.ok(/read/.test(rule(sh(`cd ${shPath(work)} && ls`, r)) ?? ""), "cd+ls");
    assert.ok(/read/.test(rule(sh(`cat ${shPath(path.join(work, "x"))}`, r)) ?? ""), "cat");
    assert.ok(/read/.test(rule(sh(`cd ${shPath(repo)} && git status`, r)) ?? ""), "git status");
  }
});

// PR5 review 2: a worktree that lies inside a work folder keeps its git defaults, at its root and below.
const outer = path.join(base, "outer");
const wt2 = path.join(outer, "wt2");
fs.mkdirSync(path.join(wt2, "sub"), { recursive: true });
fs.mkdirSync(path.join(outer, "other-repo", ".git"), { recursive: true });
const env2: FloorEnv = { ...env, cwd: wt2, writeRoots: [wt2, scr, tmpDir, "/tmp"] };
const sh2 = (line: string, cwd: string, r: GateRoots): GateOutcome => gateEvaluate("bash", { command: line }, cwd, { env: () => ({ ...env2, cwd }), roots: () => r, facts });
const GIT2 = ["git commit -m x", "git add -A", "git push origin HEAD", "git fetch", "git switch round/x"];

for (const mode of ["read", "auto"] as const) {
  test(`worktree inside a ${mode} folder keeps default-git allows at root and below`, () => {
    const r = roots({ worktree: wt2, workFolders: [{ path: outer, mode }] });
    const n = roots({ worktree: wt2, workFolders: [] });
    for (const cwd of [wt2, path.join(wt2, "sub")]) {
      for (const g of GIT2) {
        const o = sh2(g, cwd, r);
        assert.ok(/default-git/.test(rule(o) ?? ""), `${cwd}: ${g}: ${shape(o)}`);
        assert.equal(rule(o), rule(sh2(g, cwd, n)), `${cwd}: ${g}`);
      }
    }
    const o = sh2("git commit -m x", path.join(outer, "other-repo"), r);
    assert.ok(!/default-git/.test(rule(o) ?? ""), shape(o));
  });
}

test("guarded pkgRoot given as a link: its real spelling is protected too", () => {
  const r = roots({ pkgRoot: linkPkg, workFolders: [{ path: base, mode: "auto" }] });
  const target = path.join(realPkg, "extensions", "gate.ts");
  assert.equal(folderProtected(r, process.platform, target), true);
  assert.equal(folderProtected(r, process.platform, path.join(linkPkg, "extensions", "gate.ts")), true);
  assert.equal(workFolderOf(r, process.platform, target), undefined);
});
