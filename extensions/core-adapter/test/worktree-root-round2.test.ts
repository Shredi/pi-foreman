// Round-2 fixes of the worktree-root work: TS-only protected roots reach session start, `--worktree` open and doctor; the launch refusal reads the launch's own
// cwd and the isolation alias; the tasks-launch ceiling comes from round state; a colliding root falls back; PASS records key on the nested checkout's own top.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { toplevelOf } from "../reviews.ts";
import { runSessionCommand } from "../session.ts";
import type { SessionDeps } from "../session.ts";
import { launchNeedsNestedRefusal, resolveWorktreeRoot, sessionRootInputs, treeCeilingOf, worktreeRootDoctor } from "../worktreeroot.ts";
import { buildSubmoduleRig, gitIn } from "./_submodules.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const skip = process.platform === "win32" ? "POSIX path fixtures" : false;
const real = (p: string): string => fs.realpathSync(p);
const tmp = real(mkTestTmp("pf-wtroot-r2-"));
process.on("exit", () => rmTestTmp(tmp));

const home = path.join(tmp, "home");
const installRoot = path.join(tmp, "opt", "nvm", "versions", "lib", "node_modules", "pi");
const npmRoot = path.join(tmp, "opt", "nvm", "versions", "lib", "node_modules");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(installRoot, { recursive: true });
const repo = path.join(tmp, "work", "repo");
fs.mkdirSync(repo, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: repo });
fs.writeFileSync(path.join(tmp, "b.md"), "# t\n");
const base = { home, agentDir: path.join(home, ".pi", "agent"), tmpRoot: path.join(tmp, "t"), pkgRoot: path.join(tmp, "pkg") };
const roots = { installRoot, npmRoot };
const settings = [path.join(npmRoot, "<repo>"), path.join(path.dirname(npmRoot), "<repo>"), path.join(tmp, "opt", "nvm", "<repo>")];

test("resolver: a root holding the Pi install root or the global npm root is refused, one beside them is not", { skip }, () => {
  for (const s of settings) {
    const r = resolveWorktreeRoot(repo, s, { ...base, ...roots });
    assert.equal(r.error?.code, "root_blocks_protected", s);
  }
  assert.equal(resolveWorktreeRoot(repo, path.join(tmp, "srv", "<repo>"), { ...base, ...roots }).error, undefined);
});

test("resolver: /tmp and /private/tmp roots are refused", { skip }, () => {
  for (const s of ["/tmp/<repo>", "/private/tmp/<repo>"]) assert.equal(resolveWorktreeRoot(repo, s, { ...base }).error?.code, "root_blocks_protected", s);
});

test("session start: a TS-only protected root falls back with a notice", { skip }, () => {
  for (const s of settings) {
    const i = sessionRootInputs(repo, s, { ...base, ...roots });
    assert.equal(i.worktreeRoot, undefined, s);
    assert.match(i.notice ?? "", /default worktree layout/, s);
  }
  assert.ok(sessionRootInputs(repo, path.join(tmp, "srv", "<repo>"), { ...base, ...roots }).worktreeRoot);
});

test("session start: a root already holding another repo's worktree falls back with a notice", { skip }, () => {
  const rig = buildSubmoduleRig(real(mkTestTmp("pf-wtroot-r2c-")));
  try {
    const rootsDir = path.join(tmp, "shared-roots");
    const other = path.join(tmp, "otherrepo");
    fs.mkdirSync(other, { recursive: true });
    gitIn(other, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(other, "f"), "x\n");
    gitIn(other, "add", "f");
    gitIn(other, "commit", "-q", "-m", "i");
    fs.mkdirSync(path.join(rootsDir, "super"), { recursive: true });
    gitIn(other, "worktree", "add", "-q", "-b", "o1", path.join(rootsDir, "super", "o1"));
    const i = sessionRootInputs(rig.superproject, path.join(rootsDir, "<repo>"), { ...base, ...roots });
    assert.equal(i.worktreeRoot, undefined);
    assert.match(i.notice ?? "", /already holds worktrees/);
  } finally {
    rmTestTmp(path.dirname(rig.superproject));
  }
});

function deps(config: SessionDeps["config"]): SessionDeps & { spawned: string[][] } {
  const spawned: string[][] = [];
  return {
    isChild: false,
    env: {},
    agentDir: base.agentDir,
    cwd: repo,
    piSessionId: "s1",
    pkgRoot: "/pkg",
    python: "/usr/bin/python3",
    spawner: async (_c, args) => (spawned.push(args), { code: 0, stdout: "handoff: x", stderr: "", timedOut: false }),
    send: async () => "sent",
    confirm: async () => true,
    config,
    protectedRoots: roots,
    spawned,
  };
}

test("--worktree open: a root holding the install root or npm root is refused before Python runs", { skip }, async () => {
  for (const s of settings) {
    const d = deps({ close: { worktreeDir: s } });
    const r = await runSessionCommand(d, `open demo ${path.join(tmp, "b.md")} --worktree`);
    assert.equal(r.ok, false, s);
    assert.match(r.text, /root_blocks_protected/, s);
    assert.equal(d.spawned.length, 0, s);
  }
});

test("doctor: a root holding the install root is a FAIL line", { skip }, () => {
  const out = worktreeRootDoctor({ close: { worktreeDir: settings[2] } }, repo, process.platform, roots).join("\n");
  assert.match(out, /FAIL close\.worktreeDir refused/);
});

test("doctor: the case probe leaves the main checkout alone", { skip }, () => {
  const before = fs.readdirSync(repo).sort();
  worktreeRootDoctor({ close: { worktreeDir: path.join(tmp, "srv2", "<repo>") } }, repo, process.platform, roots);
  assert.deepEqual(fs.readdirSync(repo).sort(), before);
});

test("launch refusal: worktree:true, the isolation alias and a launch cwd inside a nested checkout all count", { skip }, () => {
  const rig = buildSubmoduleRig(real(mkTestTmp("pf-wtroot-r2l-")));
  try {
    const outside = path.join(tmp, "work");
    assert.equal(launchNeedsNestedRefusal({ agent: "x", worktree: true }, rig.linkedSub), true);
    assert.equal(launchNeedsNestedRefusal({ agent: "x", isolation: "worktree" }, rig.linkedSub), true);
    assert.equal(launchNeedsNestedRefusal({ tasks: [{ agent: "x", worktree: true }] }, rig.linkedSub), true);
    assert.equal(launchNeedsNestedRefusal({ agent: "x", worktree: true, cwd: rig.linkedSub }, outside), true);
    assert.equal(launchNeedsNestedRefusal({ agent: "x", isolation: "worktree", cwd: path.relative(outside, rig.plainSub) }, outside), true);
    assert.equal(launchNeedsNestedRefusal({ agent: "x", cwd: rig.linkedSub }, outside), false, "no isolation asked");
    assert.equal(launchNeedsNestedRefusal({ agent: "x", worktree: true }, rig.superproject), false);
    assert.equal(launchNeedsNestedRefusal({ agent: "x", worktree: true, cwd: repo }, outside), false);
  } finally {
    rmTestTmp(path.dirname(rig.superproject));
  }
});

test("tasks launch: the ceiling comes from the round's manifest, no binding", { skip }, () => {
  const rig = buildSubmoduleRig(real(mkTestTmp("pf-wtroot-r2t-")));
  try {
    const agentDir = path.join(tmp, "agent-r2");
    const dir = path.join(agentDir, "pi-foreman", "state", "sessions", "foreman1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ entries: [{ kind: "worktree", path: rig.tree }] }));
    assert.equal(treeCeilingOf({ cwd: rig.linkedSub, agentDir, foremanSession: "foreman1" }), rig.tree);
    assert.equal(treeCeilingOf({ cwd: rig.plainSub, agentDir, foremanSession: "foreman1", binding: null }), rig.tree);
    assert.equal(treeCeilingOf({ cwd: rig.linkedSub, agentDir, foremanSession: "other" }), rig.linkedSub);
  } finally {
    rmTestTmp(path.dirname(rig.superproject));
  }
});

test("PASS records and pr_create key on the nested checkout's own top, not the lifted root", { skip }, async () => {
  const rig = buildSubmoduleRig(real(mkTestTmp("pf-wtroot-r2p-")));
  try {
    assert.equal(real((await toplevelOf(rig.linkedSub)) ?? ""), real(rig.linkedSub));
    assert.equal(real((await toplevelOf(path.join(rig.plainSub))) ?? ""), real(rig.plainSub));
    assert.equal(real((await toplevelOf(rig.tree)) ?? ""), real(rig.tree));
  } finally {
    rmTestTmp(path.dirname(rig.superproject));
  }
});
