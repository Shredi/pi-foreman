// PR5 work folders: pathrules (rootHolds, folderProtected, workFolderOf, read classing), effects (extraWriteRoots, extraWriteGuard, segmentAlias) and
// defaults (readRoots, pathWriteOutside, shellWriteOutside, folderRelaxes) through gateEvaluate. The mode step itself is in gate-workfolders-mode.test.ts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { gateEvaluate, type GateOutcome } from "../gate.ts";
import { dangerMatch, folderRelaxes } from "../defaults.ts";
import type { DangerCall, GitFacts } from "../defaults.ts";
import { folderProtected, pathDecide, rootHolds, workFolderOf } from "../pathrules.ts";
import type { GateRoots } from "../pathrules.ts";
import { contained, segmentAlias } from "../effects.ts";
import type { EffectCtx } from "../effects.ts";
import type { FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { shPath } from "./_shpath.ts";

const base = fs.realpathSync(mkTestTmp("pf-wf-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const tmpDir = path.join(base, "tmp");
const work = path.join(base, "work");
const all = path.join(base, "all");
const pkg = path.join(all, "pkg");
const agent = path.join(all, "agent");
const pi = path.join(all, "pi");
const outside = path.join(base, "outside");
const link = path.join(base, "link");
for (const d of [path.join(wt, "src"), scr, path.join(work, "repo", ".git", "hooks"), path.join(work, "repo", ".pi", "extensions"), path.join(work, "repo", ".pi", "scratch"), path.join(work, "other-repo", ".git"), path.join(work, "wt2", "src"), path.join(pkg, "extensions", "core-adapter"), agent, pi, outside]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(work, "repo", ".git", "HEAD"), "ref: refs/heads/main\n");
fs.writeFileSync(path.join(work, "x.txt"), "x\n");
fs.writeFileSync(path.join(wt, "a.txt"), "a\n");
fs.symlinkSync(work, link);
fs.symlinkSync(outside, path.join(work, "out"));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const F = (p: string): string => shPath(p);
const roots = (o: Partial<GateRoots> = {}): GateRoots => ({
  worktree: wt, scratch: [scr], tmp: [tmpDir, "/tmp"], scratchBase: path.join(tmpDir, "pi-foreman-scratch"), owned: [], install: [pi], roundFlow: [], handoffs: [],
  child: false, role: "foreman", tmpAccess: true, agentDir: agent, pkgRoot: pkg, workFolders: [{ path: work, mode: "auto" }], ...o,
});
const facts: GitFacts = { currentBranch: () => "round/x", protectedBranches: () => ["main"], pushConfigured: () => false };
const env: FloorEnv = { cwd: wt, home: "/pf-wf/home", agentDir: "/pf-wf/agent", platform: process.platform, protectedBranches: ["main"], currentBranch: () => "round/x", remoteHead: () => "main", writeRoots: [wt, scr, tmpDir, "/tmp"] };

const gate = (tool: string, input: Record<string, unknown>, r: GateRoots = roots(), cwd = wt): GateOutcome => gateEvaluate(tool, input, cwd, { env: () => ({ ...env, cwd }), roots: () => r, facts });
const sh = (line: string, r: GateRoots = roots()): GateOutcome => gate("bash", { command: line }, r);
const callOf = (line: string, cwd = wt): DangerCall => ({ tool: "bash", input: { command: line }, text: line, segments: parseShell(line, { cwd, env: { FOREMAN_SCRATCH: scr } }) });
const relaxes = (line: string, r: GateRoots = roots()): boolean => folderRelaxes(callOf(line), { roots: r, platform: process.platform, cwd: wt, facts });
const danger = (o: GateOutcome): string | null => o.danger?.name ?? null;
const rule = (o: GateOutcome): string | null => (o.result && "allow" in o.result ? o.result.rule : null);
/** "danger": the write is not relaxed (a dangerous class entry, or a floor/self-modification ask or block that also refuses the relaxation). */
const blockRule = (o: GateOutcome): string | null => (o.result && "block" in o.result ? o.result.rule : null);
const held = (o: GateOutcome): boolean => danger(o) === "danger-write-outside" || (!!o.result && !("allow" in o.result));

test("1 reads: any path in a work folder (either mode) is a built-in allow, .git included; shell reads follow", () => {
  for (const mode of ["auto", "read"] as const) {
    const r = roots({ workFolders: [{ path: work, mode }] });
    assert.equal(rule(gate("read", { path: path.join(work, "x.txt") }, r)), "path-read-owned");
    assert.equal(rule(gate("read", { path: path.join(work, "repo", ".git", "HEAD") }, r)), "path-read-owned");
    assert.equal(rule(gate("ls", { path: path.join(work, "repo") }, r)), "path-read-owned");
    assert.match(rule(sh(`cat ${F(path.join(work, "x.txt"))}`, r)) ?? "", /^default-read/);
    assert.match(rule(sh(`ls ${F(work)}/repo`, r)) ?? "", /^default-read/);
  }
  assert.equal(rule(gate("read", { path: path.join(work, "x.txt") }, roots({ workFolders: [] }))), null);
  assert.equal(rule(gate("read", { path: path.join(outside, "x.txt") })), null);
});

test("2 writes: an uncovered write in an auto folder is no write-outside and relaxes; read folder and no folder stay danger", () => {
  const w = { path: path.join(work, "new.txt"), content: "x" };
  assert.equal(danger(gate("write", w)), null);
  assert.equal(rule(gate("write", w)), null);
  assert.equal(folderRelaxes({ tool: "write", input: w }, { roots: roots(), platform: process.platform, cwd: wt, facts }), true);
  const ro = roots({ workFolders: [{ path: work, mode: "read" }] });
  assert.equal(danger(gate("write", w, ro)), "danger-write-outside");
  assert.equal(folderRelaxes({ tool: "write", input: w }, { roots: ro, platform: process.platform, cwd: wt, facts }), false);
  assert.equal(danger(gate("write", w, roots({ workFolders: [] }))), "danger-write-outside");
  assert.equal(danger(gate("write", { path: path.join(outside, "n.txt"), content: "x" })), "danger-write-outside");
  // foreman_move: both operands in the folder relax; one outside does not
  assert.equal(folderRelaxes({ tool: "foreman_move", input: { src: path.join(work, "x.txt"), dst: path.join(work, "y.txt") } }, { roots: roots(), platform: process.platform, cwd: wt, facts }), true);
  assert.equal(folderRelaxes({ tool: "foreman_move", input: { src: path.join(work, "x.txt"), dst: path.join(outside, "y.txt") } }, { roots: roots(), platform: process.platform, cwd: wt, facts }), false);
  assert.equal(danger(gate("foreman_move", { src: path.join(work, "x.txt"), dst: path.join(outside, "y.txt") })), "danger-write-outside");
});

test("3 a worktree inside a folder keeps path-write-worktree; a write outside both is still danger", () => {
  const wt2 = path.join(work, "wt2");
  const r = roots({ worktree: wt2 });
  assert.equal(rule(gate("write", { path: path.join(wt2, "src", "a.ts"), content: "x" }, r, wt2)), "path-write-worktree");
  assert.equal(danger(gate("write", { path: path.join(outside, "a.ts"), content: "x" }, r, wt2)), "danger-write-outside");
  // .git of the worktree stays refused as today
  const hook = { path: path.join(wt2, ".git", "hooks", "pre-commit"), content: "x" };
  assert.equal(held(gate("write", hook, r, wt2)), true);
  assert.equal(folderRelaxes({ tool: "write", input: hook }, { roots: r, platform: process.platform, cwd: wt2, facts }), false);
});

test("4 protected places inside an auto folder stay danger, in both spellings; .pi/scratch relaxes", () => {
  const r = roots({ workFolders: [{ path: all, mode: "auto" }], worktree: path.join(all, "wt3") });
  const lnk = path.join(base, "alllink");
  fs.symlinkSync(all, lnk);
  const both = roots({ ...r, workFolders: [{ path: all, mode: "auto" }, { path: lnk, mode: "auto" }] });
  const protectedPaths = [
    path.join(all, "other-repo", ".git", "config"),
    path.join(all, "repo", ".pi", "extensions", "x.ts"),
    path.join(all, "repo", ".GIT", "hooks", "x"),
    path.join(pkg, "extensions", "core-adapter", "gate.ts"),
    path.join(agent, "settings.json"),
    path.join(pi, "x.js"),
  ];
  for (const p of protectedPaths) {
    for (const spelled of [p, p.replace(all, lnk)]) {
      assert.equal(folderProtected(both, process.platform, spelled), true, spelled);
      assert.equal(workFolderOf(both, process.platform, spelled), undefined, spelled);
      assert.equal(folderRelaxes({ tool: "write", input: { path: spelled } }, { roots: both, platform: process.platform, cwd: wt, facts }), false, spelled);
      assert.equal(held(gate("write", { path: spelled, content: "x" }, both)), true, spelled);
    }
  }
  assert.equal(workFolderOf(both, process.platform, path.join(all, "repo", ".pi", "scratch", "n"))?.mode, "auto");
  assert.equal(workFolderOf(both, process.platform, path.join(all, "repo", ".pi", "tasks", "n"))?.mode, "auto");
  assert.equal(workFolderOf(both, process.platform, path.join(all, "repo", "src", "n.ts"))?.mode, "auto");
  assert.equal(danger(gate("write", { path: path.join(all, "repo", ".pi", "scratch", "n"), content: "x" }, both)), null);
});

test("5 shell: writeVerb forms relax; protected targets, redirects and non-default segments stay danger", () => {
  // tee is a writing wrapper (opaque to the parser), so it never relaxes: danger-opaque, as today
  assert.equal(danger(sh(`tee ${F(work)}/notes.txt`)), "danger-opaque");
  assert.equal(relaxes(`tee ${F(work)}/notes.txt`), false);
  for (const l of [`touch ${F(work)}/x`, `mkdir ${F(work)}/d`, `cp ${F(wt)}/a.txt ${F(work)}/b.txt`, `touch ${F(work)}/x ${F(work)}/y`]) {
    assert.equal(danger(sh(l)), null, l);
    assert.equal(relaxes(l), true, l);
    assert.equal(rule(sh(l)), null, `${l}: no built-in allow, the mode step decides`);
  }
  for (const l of [
    `tee ${F(work)}/repo/.git/hooks/post-checkout`,
    `echo x | tee ${F(work)}/repo/.pi/extensions/x.ts`,
    `touch ${F(work)}/repo/.GIT/hooks/x`,
    `tee ${F(pkg)}/extensions/core-adapter/gate.ts`,
  ]) {
    const r = roots({ workFolders: [{ path: l.includes(F(pkg)) ? all : work, mode: "auto" }] });
    assert.equal(relaxes(l, r), false, l);
    assert.ok(held(sh(l, r)) || danger(sh(l, r)) === "danger-opaque", l);
  }
  for (const l of [`echo x > ${F(work)}/notes.txt`, `python3 build.py > ${F(work)}/out.txt`, `cat /etc/hosts > ${F(work)}/y`]) {
    assert.equal(relaxes(l), false, l);
    assert.equal(danger(sh(l)), "danger-write-outside", l);
  }
  // a redirect into the worktree is unchanged, with or without folders
  assert.deepEqual([danger(sh(`echo x > ${F(wt)}/n.txt`)), rule(sh(`echo x > ${F(wt)}/n.txt`))], [danger(sh(`echo x > ${F(wt)}/n.txt`, roots({ workFolders: [] }))), rule(sh(`echo x > ${F(wt)}/n.txt`, roots({ workFolders: [] })))]);
  // never defaults: directory targets of extractors stay danger under any mode
  for (const l of [`tar -xf a.tgz -C ${F(work)}/repo`, `unzip -d ${F(work)}/repo a.zip`]) {
    assert.equal(relaxes(l), false, l);
    assert.equal(held(sh(l)), true, l);
  }
  // rm and mv are unchanged from today
  for (const l of [`rm ${F(work)}/x.txt`, `mv ${F(work)}/x.txt ${F(work)}/y.txt`]) {
    assert.equal(relaxes(l), false, l);
    assert.equal(danger(sh(l)), danger(sh(l, roots({ workFolders: [] }))), l);
  }
  // one relaxed segment does not carry an unknown one
  assert.equal(relaxes(`touch ${F(work)}/x && python3 build.py`), false);
  assert.equal(danger(sh(`touch ${F(work)}/x && python3 ${F(outside)}/b.py > ${F(outside)}/o`)), "danger-write-outside");
  // a read folder: unchanged
  assert.equal(danger(sh(`touch ${F(work)}/x`, roots({ workFolders: [{ path: work, mode: "read" }] }))), "danger-write-outside");
});

test("9 symlinks: a link out of the folder is not inside; a folder spelled through a link is inside via the real entry", () => {
  assert.equal(rootHolds(work, path.join(work, "out", "f.txt"), process.platform), false);
  assert.equal(workFolderOf(roots(), process.platform, path.join(work, "out", "f.txt")), undefined);
  assert.equal(danger(gate("write", { path: path.join(work, "out", "f.txt"), content: "x" })), "danger-write-outside");
  assert.equal(rule(gate("read", { path: path.join(work, "out", "f.txt") })), null);
  // the folder named through the link: its real spelling is stored beside it by the adapter
  const r = roots({ workFolders: [{ path: link, mode: "auto" }, { path: work, mode: "auto" }] });
  assert.equal(workFolderOf(r, process.platform, path.join(work, "n.txt"))?.mode, "auto");
  assert.equal(workFolderOf(r, process.platform, path.join(link, "n.txt"))?.mode, "auto");
  assert.equal(rootHolds(link, path.join(link, "n.txt"), process.platform), true);
});

test("10 children: no folders, child-write-outside unchanged", () => {
  const c = roots({ child: true, role: "builder", workFolders: [] });
  const o = gate("write", { path: path.join(work, "n.txt"), content: "x" }, c);
  assert.equal(blockRule(o), "child-write-outside");
  assert.equal(rule(gate("read", { path: path.join(work, "x.txt") }, c)), null);
  // even handed folders, a child gets nothing from them
  const cf = roots({ child: true, role: "builder" });
  assert.equal(blockRule(gate("write", { path: path.join(work, "n.txt"), content: "x" }, cf)), "child-write-outside");
  assert.equal(relaxes(`touch ${F(work)}/x`, cf), false);
  assert.equal(rule(gate("read", { path: path.join(work, "x.txt") }, cf)), null);
});

test("two folders: the innermost wins; paths in two folders do not relax together", () => {
  const inner = path.join(work, "repo");
  const r = roots({ workFolders: [{ path: work, mode: "auto" }, { path: inner, mode: "read" }] });
  assert.equal(workFolderOf(r, process.platform, path.join(inner, "src", "a.ts"))?.mode, "read");
  assert.equal(workFolderOf(r, process.platform, path.join(work, "x.txt"))?.mode, "auto");
  const two = roots({ workFolders: [{ path: work, mode: "auto" }, { path: path.join(base, "work2"), mode: "auto" }] });
  assert.equal(folderRelaxes({ tool: "foreman_move", input: { src: path.join(work, "x.txt"), dst: path.join(base, "work2", "y.txt") } }, { roots: two, platform: process.platform, cwd: wt, facts }), false);
});

test("effects: extraWriteRoots and extraWriteGuard are consulted for writes only; segmentAlias folds .git and .pi", () => {
  const ec: EffectCtx = { cwd: wt, root: wt, scratch: [], platform: process.platform, extraWriteRoots: [work], extraWriteGuard: (abs) => abs.includes("guarded") };
  assert.equal(contained(ec, wt, path.join(work, "n.txt"), true), true);
  assert.equal(contained(ec, wt, path.join(work, "guarded", "n.txt"), true), false);
  assert.equal(contained(ec, wt, path.join(work, "repo", ".git", "x"), true), false);
  assert.equal(contained(ec, wt, path.join(work, "n.txt"), false), false, "extra write roots are not read roots");
  assert.equal(contained({ ...ec, extraWriteRoots: undefined }, wt, path.join(work, "n.txt"), true), false);
  assert.equal(segmentAlias("linux", ".git", ".git"), true);
  assert.equal(segmentAlias("darwin", ".git", ".GIT"), true);
  assert.equal(segmentAlias("win32", ".git", "GIT~1"), true);
  assert.equal(segmentAlias("linux", ".pi", ".pi"), true);
  assert.equal(segmentAlias("linux", ".git", "src"), false);
});

test("dangerous class: a dangerous call in a folder is not relaxed", () => {
  const l = `touch ${F(work)}/x && git push origin main`;
  assert.equal(relaxes(l), false);
  assert.notEqual(dangerMatch(callOf(l), { roots: roots(), platform: process.platform, cwd: wt, facts }), null);
});

test("pathDecide still classes the worktree first and never allows a folder write", () => {
  assert.equal(pathDecide("write", { path: path.join(work, "n.txt") }, wt, roots(), process.platform), undefined);
  assert.equal(pathDecide("read", { path: path.join(work, "n.txt") }, wt, roots(), process.platform)?.rule, "path-read-owned");
});
