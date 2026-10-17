// R5 final review B1+B2: `$HOME` / `$S` are trusted only while the line binds them nowhere, and the grammar's
// resolution feeds every target set (a rebound variable in a write target fails closed).
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
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-secbound-")));
after(() => rmTestTmp(base));

const home = path.join(base, "home");
const agentDir = path.join(home, ".pi", "agent");
const main = path.join(base, "repo");
const rt = path.join(base, "repo.worktrees", "round");
const scratch = path.join(base, "tmp", "pi-foreman-scratch", "child1");
const prot = path.join(agentDir, "foreman.json");
for (const d of [path.join(main, ".workflow"), agentDir, scratch, rt]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(prot, "{}\n");
if (posix) execFileSync("git", ["init", "-q", rt], { stdio: "ignore" });
const owned = ownedRoots({ agentDir, workspaceRoot: main, tmpRoot: path.join(base, "tmp"), npmRoot: null });
const rules = buildOverlayRules(baseline, {}, {}, agentDir, pkgRoot, undefined, false, owned);

const foreman = (command: string): string => checkToolCall(rules, "bash", { command }, { cwd: main, home, platform: process.platform, role: "main", owned })?.kind ?? "pass";
const child = (command: string): string => {
  const s = childSurface([rt], rt, "reviewer", process.platform);
  const ctx: MatchCtx = { cwd: rt, home, platform: process.platform, role: "child", scratch, roundRoots: s.write, roundReadRoots: s.read };
  return checkToolCall(rules, "bash", { command }, ctx)?.kind ?? "pass";
};

test("B1: a line that rebinds HOME never gets $HOME trusted (sed -i / rg --pre injection)", { skip: !posix }, () => {
  for (const line of [
    `HOME=-i; sed $HOME -e s/a/b/ ${prot}`,
    `HOME=--pre=sh; rg $HOME x f`,
    `export HOME=-i; sed $HOME -e s/a/b/ ${prot}`,
    `env HOME=-i sed $HOME -e s/a/b/ ${prot}`,
    `declare HOME=-i; sed $HOME -e s/a/b/ ${prot}`,
    `read HOME; sed $HOME -e s/a/b/ ${prot}`,
    `for HOME in -i; do sed $HOME -e s/a/b/ ${prot}; done`,
    `printf -v HOME %s -i; sed $HOME -e s/a/b/ ${prot}`,
    `HOME=/; cat ~/x`,
  ]) {
    assert.equal(foreman(line), "deny", line);
    assert.equal(child(line), "deny", line);
  }
  // bare `$HOME` (no `/`) is no trusted prefix: the protected reader exemption does not apply
  assert.notEqual(foreman(`sed $HOME -e s/a/b/ ${prot}`), "pass");
  // the literal prefix still reads
  assert.equal(foreman("cat $HOME/.pi/agent/pi-foreman/x"), "pass");
});

test("B2: a rebound $S in any target set fails closed (redirect, tee, /tmp)", { skip: !posix }, () => {
  for (const line of [
    `S=${rt}; echo x > $S/f`,
    `S=${rt}; echo x | tee $S/f`,
    `S=/tmp; echo x | tee $S/x`,
    `S=/tmp; echo x > $S/x`,
    `O=${rt}; echo x | tee $O/f`,
  ]) assert.equal(child(line), "deny", line);
});

test("R8: an unbound $S is the child's scratch; S=<round worktree> is not", { skip: !posix }, () => {
  assert.equal(child("npm run typecheck > $S/typecheck.log"), "pass");
  assert.equal(child("S=$FOREMAN_SCRATCH; echo x > $S/f"), "pass");
  assert.equal(child(`S=${rt}; echo x > $S/f`), "deny");
});
