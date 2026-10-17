// R6 lane 2 security and 2e: sed counts as a protected reader only when it provably only reads; `git apply <patch>` / `patch -p1 < <patch>` read the
// patch file and write the cwd worktree (allowed in an owned worktree, closed in a non-owned one and for a read-only child).
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
import { rmTestTmp } from "./_tmpbase.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-lane2a-")));
after(() => rmTestTmp(base));

const agentDir = path.join(base, "agent");
const main = path.join(base, "repo");
const rt = path.join(base, "repo.worktrees", "round");
const other = path.join(base, "repo.worktrees", "other");
const scratch = path.join(base, "tmp", "pi-foreman-scratch", "child1");
const mainPatch = path.join(main, ".workflow", "scratch", "x.patch");
const ownPatch = path.join(scratch, "x.patch");
for (const d of [path.dirname(mainPatch), rt, other, scratch, path.join(agentDir, "pi-foreman")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(mainPatch, "--- a/f.txt\n+++ b/f.txt\n");
fs.writeFileSync(ownPatch, "--- a/f.txt\n+++ b/f.txt\n");
fs.writeFileSync(path.join(rt, "f.txt"), "f\n");
fs.writeFileSync(path.join(rt, "package.json"), "{}\n");
fs.mkdirSync(path.join(rt, ".agents"), { recursive: true });
fs.writeFileSync(path.join(rt, ".agents", "a.md"), "a\n");
const prot = ".agents/a.md"; // write-protected (ask / child deny), a read of it passes
if (posix) for (const d of [rt, other, main]) execFileSync("git", ["init", "-q", d], { stdio: "ignore" });
const owned = ownedRoots({ agentDir, workspaceRoot: main, tmpRoot: path.join(base, "tmp"), npmRoot: null });
const rules = buildOverlayRules(baseline, {}, {}, agentDir, pkgRoot, undefined, false, owned);

const child = (command: string, o: { cwd?: string; role?: string } = {}): string => {
  const cwd = o.cwd ?? rt;
  const s = childSurface([rt], cwd, o.role ?? "builder", process.platform);
  const ctx: MatchCtx = { cwd, home: base, platform: process.platform, role: "child", scratch, roundRoots: s.write, roundReadRoots: s.read };
  return checkToolCall(rules, "bash", { command }, ctx)?.kind ?? "pass";
};
const foreman = (command: string, cwd = main): string => checkToolCall(rules, "bash", { command }, { cwd, home: base, platform: process.platform, role: "main", owned })?.kind ?? "pass";

test("sed security: a print-only sed is a reader of a protected file", { skip: !posix }, () => {
  assert.equal(foreman("sed -n 1,5p package.json", rt), "pass");
  assert.equal(child("sed -n 1,5p package.json"), "pass");
  assert.equal(foreman(`sed -n '1,5p' ${prot}`, rt), "pass");
  assert.equal(foreman(`sed -n 1,5p ${prot} | head -2`, rt), "pass");
  assert.equal(foreman(`cat ${prot}`, rt), "pass");
  // the same file is protected against a write
  assert.notEqual(foreman(`touch ${prot}`, rt), "pass");
  assert.equal(child(`touch ${prot}`), "deny");
});

test("sed security: in-place, w/W, e, s///w, s///e and script files are not readers of a protected file", { skip: !posix }, () => {
  const cmds = [
    `sed -i 1d ${prot}`,
    `sed --in-place 1d ${prot}`,
    `sed -i.bak 1d ${prot}`,
    `sed -n -i 1p ${prot}`,
    `sed 's/a/b/w /tmp/x' ${prot}`,
    `sed -n 's/a/b/w out.txt' ${prot}`,
    `sed -e '1e id' ${prot}`,
    `sed -e '1w out.txt' ${prot}`,
    `sed -e '1W out.txt' ${prot}`,
    `sed 's/a/b/e' ${prot}`,
    `sed -f script.sed ${prot}`,
    `sed --file=script.sed ${prot}`,
    `sed -f ${mainPatch} ${prot}`,
    `I=-i; sed $I 1d ${prot}`,
  ];
  for (const c of cmds) {
    assert.notEqual(foreman(c, rt), "pass", c);
    assert.notEqual(child(c), "pass", c);
  }
});

test("sed security: a write redirect or a protected target still blocks a print-only sed", { skip: !posix }, () => {
  assert.notEqual(foreman(`sed -n 1,5p package.json > ${prot}`, rt), "pass");
  assert.notEqual(foreman(`sed -n 1,5p package.json | tee ${prot}`, rt), "pass");
});

test("2e: git apply of a patch under the main scratch or the own scratch inside an owned worktree does not ask", { skip: !posix }, () => {
  assert.equal(child(`git apply ${mainPatch}`), "pass");
  assert.equal(child(`git apply ${ownPatch}`), "pass");
  assert.equal(child(`git apply -p1 ${ownPatch}`), "pass");
  assert.equal(child(`patch -p1 < ${mainPatch}`), "pass");
  assert.equal(child(`patch -p1 < ${ownPatch}`), "pass");
  assert.equal(child(`patch -p1 -i ${ownPatch}`), "pass");
  assert.equal(child(`git apply --check ${ownPatch}`), "pass");
});

test("2e: the same apply inside a non-owned worktree, or with a non-owned target, still asks or denies", { skip: !posix }, () => {
  // an apply is as open or closed as any other write to the same cwd
  for (const c of [`git apply ${ownPatch}`, `patch -p1 < ${ownPatch}`, `patch -p1 -i ${ownPatch}`]) {
    for (const cwd of [other, main]) assert.equal(child(c, { cwd }), child("touch f.txt", { cwd }), `${cwd}: ${c}`);
  }
  assert.notEqual(child(`git apply -C ${other} ${ownPatch}`), "pass");
  assert.notEqual(child(`patch -d ${other} -p1 < ${ownPatch}`), "pass");
  assert.notEqual(child(`patch -p1 -o ${other}/out.txt < ${ownPatch}`), "pass");
});

test("2e: a read-only child (reviewer, explorer) stays denied an apply or patch", { skip: !posix }, () => {
  for (const role of ["reviewer", "explorer"]) {
    for (const c of [`git apply ${ownPatch}`, `patch -p1 < ${ownPatch}`, `git apply ${mainPatch}`]) assert.equal(child(c, { role }), "deny", `${role}: ${c}`);
    // a check-only apply writes nothing
    assert.notEqual(child(`git apply --check ${ownPatch}`, { role }), "deny", role);
  }
});
