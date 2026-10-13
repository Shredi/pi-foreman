// R6 lane 2, items 2b-2f: path rules match path operands only, reads under owned roots are never denied by a `*` rule, `../x` after `cd` resolves
// from the cd'd directory, only reads of the state dir lose the protected-configuration ask, `git apply` / `patch` read their patch file and
// write the cwd worktree, and the round ledger / the session's handoff dir / the session's round worktrees are readable roots for children.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx } from "../permoverlay.ts";
import { ownedRoots } from "../owned.ts";
import { childSurface } from "../roundsurface.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-lane2p-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const agentDir = path.join(base, "agent");
const main = path.join(base, "repo");
const rt = path.join(base, "repo.worktrees", "round");
const scratch = path.join(base, "tmp", "pi-foreman-scratch", "child1");
const adapter = path.join(rt, "extensions", "core-adapter");
const stateDir = path.join(agentDir, "pi-foreman", "state");
const handoff = path.join(agentDir, "pi-foreman", "handoffs", "s1");
const ledger = path.join(main, ".workflow", "LEDGER-round.md");
for (const d of [path.join(main, ".workflow"), path.join(adapter), path.join(rt, "extensions", "git-guard"), path.join(stateDir, "usage"), handoff, scratch]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(ledger, "# ledger\n");
fs.writeFileSync(path.join(main, ".workflow", "LEDGER-other.md"), "# other\n");
fs.writeFileSync(path.join(handoff, "brief.md"), "brief\n");
fs.writeFileSync(path.join(adapter, "index.ts"), "// i\n");
fs.writeFileSync(path.join(rt, "extensions", "git-guard", "index.ts"), "// g\n");
fs.writeFileSync(path.join(rt, "package.json"), "{}\n");
fs.writeFileSync(path.join(stateDir, "usage", "a.jsonl"), "{}\n");
if (posix) {
  execFileSync("git", ["init", "-q", rt], { stdio: "ignore" });
  fs.mkdirSync(path.join(rt, "scratch-in"), { recursive: true });
}
const owned = ownedRoots({ agentDir, workspaceRoot: main, tmpRoot: path.join(base, "tmp"), npmRoot: null });
const rules = (merged: object = {}) => buildOverlayRules(baseline, merged, {}, agentDir, pkgRoot, undefined, false, owned);
const readable = [ledger, path.join(path.dirname(ledger), "LEDGER-*.md"), handoff, `${handoff}/*`, rt, `${rt}/*`];

const child = (command: string, o: { cwd?: string; role?: string; merged?: object; rounds?: string[] } = {}): string => {
  const cwd = o.cwd ?? rt;
  const s = childSurface(o.rounds ?? [rt], cwd, o.role ?? "reviewer", process.platform);
  const ctx: MatchCtx = { cwd, home: base, platform: process.platform, role: "child", scratch, roundRoots: s.write, roundReadRoots: s.read, readable };
  return checkToolCall(rules(o.merged), "bash", { command }, ctx)?.kind ?? "pass";
};
const foreman = (command: string, cwd = main, merged: object = {}): string => checkToolCall(rules(merged), "bash", { command }, { cwd, home: base, platform: process.platform, role: "main", owned })?.kind ?? "pass";
const star = { paths: { deny: ["*"] } };

test("2b: a catch-all path rule never fires on a word of command prose", { skip: !posix }, () => {
  assert.equal(foreman('git commit --reason "read index.ts, then fix it"', adapter, star), "pass");
  assert.equal(child('git log --reason "read index.ts, then fix it"', { cwd: adapter, merged: star }), "pass");
  // the rule still matches real operands
  assert.equal(foreman("cat /etc/hosts", adapter, star), "deny");
  assert.equal(foreman("cat ./index.ts", adapter, star), "deny");
});

test("2b security: a `*` deny still catches a write target or a write/edit path with white space in it", { skip: !posix }, () => {
  const spaced = path.join(main, "a b.txt");
  const ctx: MatchCtx = { cwd: adapter, home: base, platform: process.platform, role: "main", owned };
  for (const tool of ["write", "edit"]) {
    const d = checkToolCall(rules(star), tool, { path: spaced, content: "x", oldText: "a", newText: "b" }, ctx);
    assert.equal(d?.kind, "deny", tool);
    assert.match(d?.reason ?? "", /path rule '\*'/);
  }
  assert.equal(foreman(`echo x > "${spaced}"`, adapter, star), "deny");
  assert.equal(foreman(`tee "${spaced}"`, adapter, star), "deny");
  assert.equal(child(`echo x > "${path.join(main, "a b")}"`, { cwd: adapter, merged: star }), "deny");
  // prose in a non-target word still passes
  assert.equal(foreman('git commit --reason "read index.ts, then fix it"', adapter, star), "pass");
});

test("2b: reads under owned roots are never denied by a `*` path rule", { skip: !posix }, () => {
  assert.equal(child(`cat ${scratch}/x.txt`, { merged: star }), "pass");
  assert.equal(child(`cat ${rt}/package.json`, { merged: star }), "pass");
  assert.equal(child(`cat ${ledger}`, { merged: star }), "pass");
  assert.equal(child(`cat ${handoff}/brief.md`, { merged: star }), "pass");
  assert.equal(child("cat /etc/hosts", { merged: star }), "deny");
  assert.equal(child(`cat ${main}/package.json`, { merged: star }), "deny");
  // a more specific rule is not a catch-all: secrets inside an owned root stay denied
  assert.equal(child(`cat ${rt}/.env`), "deny");
});

test("2b: a sed expression is no path; a real write to .git/config is still denied", { skip: !posix }, () => {
  assert.equal(foreman("env | grep ^GIT_CONFIG | sed 's/=.*//'", rt), "pass");
  assert.equal(child("env | grep ^GIT_CONFIG | sed 's/=.*//'"), "pass");
  assert.equal(foreman("echo x > .git/config", rt), "deny");
  assert.equal(foreman(`echo x >> ${rt}/.git/config`, rt), "deny");
  assert.equal(foreman("sed -i 's/a/b/' .git/config", rt), "deny");
  assert.equal(foreman("sed 'w .git/config' package.json", rt), "deny");
});

test("2b: `sed -n 1,5p package.json` is a read, not a write", { skip: !posix }, () => {
  assert.equal(child("sed -n 1,5p package.json"), "pass");
  assert.equal(foreman("sed -n 1,5p package.json", rt), "pass");
  assert.equal(foreman("sed -i 1d .git/config", rt), "deny");
});

test("2b: a reviewer in the main checkout reads its own round worktree through ../<repo>.worktrees/<round>", { skip: !posix }, () => {
  const rel = `../repo.worktrees/round/extensions/git-guard/index.ts`;
  assert.equal(child(`cat ${rel}`, { cwd: main, role: "reviewer" }), "pass");
  assert.equal(child(`cat ${rt}/package.json`, { cwd: main, role: "reviewer" }), "pass");
  // another round worktree (not recorded for this session) stays closed
  assert.equal(child("cat ../repo.worktrees/other/package.json", { cwd: main, role: "reviewer" }), "deny");
  // a write there stays denied
  assert.equal(child(`touch ${rt}/new.txt`, { cwd: main, role: "reviewer" }), "deny");
});

test("2c: `../x` after cd resolves from the cd'd directory", { skip: !posix }, () => {
  assert.equal(child("cd extensions/core-adapter && cat ../git-guard/index.ts"), "pass");
  assert.equal(child("cd extensions/core-adapter; cat ../git-guard/index.ts"), "pass");
  assert.equal(foreman("cd extensions/core-adapter && cat ../git-guard/index.ts", rt), "pass");
  // without a cd the same word resolves from the cwd, out of the worktree: still closed
  assert.equal(child("cat ../git-guard/index.ts"), "deny");
  // a cd that does not run first (|| / background / missing dir) does not move the base
  assert.equal(child("cd nope-dir && cat ../x"), "deny");
  assert.equal(child("cd extensions/core-adapter || cat ../git-guard/index.ts"), "deny");
});

test("2d: only reads of the state dir lose the protected-configuration ask", { skip: !posix }, () => {
  const st = path.join(stateDir, "usage");
  for (const cmd of [`ls ${st}`, `cat ${st}/a.jsonl`, `cd ${st} && ls`, `cd ${st} && cat *.jsonl`, `cat ${st}/*.jsonl | head -3`, `ls ${stateDir}`, `head -5 ${st}/a.jsonl | sed -n 1,2p`]) {
    assert.equal(foreman(cmd), "pass", cmd);
  }
  for (const cmd of [`echo x > ${st}/a.jsonl`, `rm ${st}/a.jsonl`, `touch ${stateDir}/new`, `sed -i 1d ${st}/a.jsonl`, `python3 -c "open('${st}/a.jsonl','w').write('')"`, `python3 -c "import os; os.remove('${st}/a.jsonl')"`, `cp x ${stateDir}/foreman.json`, `echo x > ${agentDir}/foreman.json`, `echo x > ${agentDir}/auth.json`, `echo x > ${agentDir}/extensions/x.ts`]) {
    assert.notEqual(foreman(cmd), "pass", cmd);
  }
});

test("2d: inline python over the state dir is never a reader and still asks (fail closed)", { skip: !posix }, () => {
  const st = path.join(stateDir, "usage");
  for (const cmd of [
    `python3 -c "import pathlib; print('', file=pathlib.Path('${st}/a.jsonl').open('w'))"`,
    `python3 -c "import os; os.posix_spawn('/bin/sh', ['sh','-c','true'], {}); print(open('${st}/a.jsonl').read())"`,
    `python3 -c "import pathlib; pathlib.Path('${st}/l').symlink_to('/x')"`,
    `python3 -c "print(open('${st}/a.jsonl').read())"`,
    `python3 -c "import json,glob; print(len(glob.glob('${st}/*.jsonl')))"`,
    `python3 -I -c "print(open('${st}/a.jsonl').read())"`,
  ]) {
    assert.notEqual(foreman(cmd), "pass", cmd);
  }
  // a plain reader of the same file still passes
  assert.equal(foreman(`cat ${st}/a.jsonl`), "pass");
});

test("2f: the round ledger and the session's handoff dir are readable for a child; writes stay closed", { skip: !posix }, () => {
  for (const role of ["explorer", "reviewer", "builder"]) {
    assert.equal(child(`cat ${ledger}`, { role }), "pass", role);
    assert.equal(child(`cat ${path.dirname(ledger)}/LEDGER-other.md`, { role }), "pass", role);
    assert.equal(child(`cat ${handoff}/brief.md`, { role }), "pass", role);
    assert.equal(child(`ls ${handoff}`, { role }), "pass", role);
  }
  for (const cmd of [`echo x > ${ledger}`, `echo x > ${handoff}/brief.md`, `rm ${handoff}/brief.md`, `cat ${agentDir}/pi-foreman/handoffs/other/brief.md`]) assert.equal(child(cmd, { role: "builder" }), "deny", cmd);
});
