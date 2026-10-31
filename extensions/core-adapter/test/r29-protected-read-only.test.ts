// R29 item 7: the write protection of a child's shell line applies to write effects only. A read-only unit (a reader verb or a read-only
// git subcommand) that names a protected file (`{pkgRoot}/*` writeAsk) passes; any write form on the same file stays denied.
import { test, after } from "node:test";
import assert from "node:assert/strict";
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
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r29-protread-")));
after(() => rmTestTmp(base));

const agentDir = path.join(base, "agent");
const scratch = path.join(base, "tmp", "pi-foreman-scratch", "child1");
for (const d of [scratch, path.join(agentDir, "pi-foreman")]) fs.mkdirSync(d, { recursive: true });

// A child whose cwd is its own workspace root `root` (a tmp package checkout), so the result does not depend on where the real checkout lives:
// the real one may sit under `<repo>.worktrees/<x>`, where the `*.worktrees/*` block reads any other cwd as a sibling worktree.
// `package.json` there is a writeAsk path (`{root}/*`).
const childIn = (root: string): ((command: string) => string) => {
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  const owned = ownedRoots({ agentDir, workspaceRoot: root, tmpRoot: path.join(base, "tmp"), npmRoot: null });
  const rules = buildOverlayRules(baseline, {}, {}, agentDir, root, undefined, false, owned);
  return (command: string): string => {
    const s = childSurface([root], root, "builder", process.platform);
    const ctx: MatchCtx = { cwd: root, home: base, platform: process.platform, role: "child", scratch, roundRoots: s.write, roundReadRoots: s.read };
    return checkToolCall(rules, "bash", { command }, ctx)?.kind ?? "pass";
  };
};
const child = childIn(path.join(base, "pkg"));

test("a child's read of a protected file passes: git diff, grep, cat", { skip: !posix }, () => {
  assert.equal(child("git diff HEAD~1..HEAD -- package.json"), "pass");
  assert.equal(child("git diff -- package.json"), "pass");
  assert.equal(child("git -C . diff -- package.json"), "pass");
  assert.equal(child("git log -p -- package.json"), "pass");
  assert.equal(child("git show HEAD:README.md | grep -n x"), "pass");
  assert.equal(child("grep x package.json"), "pass");
  assert.equal(child("cat package.json"), "pass");
  assert.equal(child("cat package.json | head -2"), "pass");
});

test("a child's write to a protected file is denied: redirect, sed -i, tee, git checkout, git apply", { skip: !posix }, () => {
  assert.equal(child("echo x > package.json"), "deny");
  assert.equal(child("sed -i 's/a/b/' package.json"), "deny");
  assert.equal(child("tee package.json"), "deny");
  assert.equal(child("git checkout -- package.json"), "deny");
  assert.equal(child("git apply package.json"), "deny");
});

test("a git read that writes its output to a protected file is denied", { skip: !posix }, () => {
  assert.equal(child("git diff --output=package.json"), "deny");
  assert.equal(child("git log --output package.json"), "deny");
  assert.equal(child("git diff -- package.json > package.json"), "deny");
  assert.equal(child("git diff -- package.json | tee package.json"), "deny");
});

test("git shapes that run a program or write stay denied on a protected file", { skip: !posix }, () => {
  for (const c of [
    "git grep -Otee x -- package.json",
    "git grep -O tee x -- package.json",
    "git grep --open-files-in-pager=tee x -- package.json",
    "git diff --ext-diff -- package.json",
    "git log --textconv -p -- package.json",
    "git -c core.pager=tee log -- package.json",
    "git config --file package.json a.b c",
  ]) assert.equal(child(c), "deny", c);
});

test("read-only git shapes on a protected file pass", { skip: !posix }, () => {
  for (const c of ["git diff a..b -- package.json", "git log -p -- package.json", "git show HEAD:package.json"]) assert.equal(child(c), "pass", c);
});

test("a git unit with an env prefix or wrapper is no protected reader", { skip: !posix }, () => {
  for (const c of [
    "GIT_EXTERNAL_DIFF=rm git diff -- package.json",
    "env GIT_EXTERNAL_DIFF=rm git diff -- package.json",
    "GIT_CONFIG_COUNT=1 git log -- package.json",
    "command git diff -- package.json",
    "nice git diff -- package.json",
  ]) assert.equal(child(c), "deny", c);
});

test("git grep is no protected reader, and -O forms stay denied", { skip: !posix }, () => {
  for (const c of [
    "git grep x -- package.json",
    "git grep -Orm x -- package.json",
    "git grep -1Oecho x -- package.json",
    "git grep -n1Oecho x -- package.json",
    "git grep --open-files-in-pager=rm x -- package.json",
    "git grep --op=rm x -- package.json",
  ]) assert.equal(child(c), "deny", c);
});

test("abbreviated write options of a git read stay denied on a protected file", { skip: !posix }, () => {
  for (const c of ["git diff --ext-d -- package.json", "git diff --ext -- package.json", "git log --textc -p -- package.json", "git diff --outp=x -- package.json"]) assert.equal(child(c), "deny", c);
});

test("plain git readers still pass on a protected file (new cases)", { skip: !posix }, () => {
  for (const c of ["git diff a..b -- package.json", "git log -p -- package.json", "git show HEAD:package.json", "git -C sub diff -- package.json"]) assert.equal(child(c), "pass", c);
});

test("git protected readers are a strict option allowlist: brace, format and unlisted options are denied", { skip: !posix }, () => {
  const F = "package.json";
  for (const c of [
    `git diff --{output=${F},stat} -- x`,
    `git diff --{out,}put=${F}`,
    `git diff -- {${F},x}`,
    `git log --format=%H -- ${F}`,
    `git diff --word-diff -- ${F}`,
    `git show --pretty=x HEAD:${F}`,
    `git -C a -C b diff -- ${F}`,
    `git diff --stat=1 -- ${F}`,
    `git log -n x -- ${F}`,
  ]) assert.equal(child(c), "deny", c);
});

test("git protected readers with listed options and plain operands pass", { skip: !posix }, () => {
  const F = "package.json";
  for (const c of [
    `git diff a..b -- ${F}`,
    `git diff --stat main..HEAD -- ${F}`,
    `git log -p -n3 -- ${F}`,
    `git log --oneline -5 -- ${F}`,
    `git show HEAD:${F}`,
    `git status --short ${F}`,
    `git -C sub diff -- ${F}`,
  ]) assert.equal(child(c), "pass", c);
});

test("an assignment unit anywhere in the line ends a protected read", { skip: !posix }, () => {
  const F = "package.json";
  for (const c of [
    `PATH=/tmp/e; git diff -- ${F}`,
    `PATH=/tmp/e; cat ${F}`,
    `LD_PRELOAD=/tmp/x.so; git diff -- ${F}`,
    `X=1; git log -- ${F}`,
    `PATH=/tmp/e && cat ${F}`,
    `true; PATH=/tmp/e; cat ${F}`,
  ]) assert.equal(child(c), "deny", c);
  for (const c of [`git diff a..b -- ${F}`, `cat ${F}`, `git -C sub diff -- ${F}`, `cd sub && git diff -- ../${F}`]) assert.equal(child(c), "pass", c);
});

test("a chain mixing a read and a write to a protected file is denied", { skip: !posix }, () => {
  assert.equal(child("git diff -- package.json && echo x > package.json"), "deny");
  assert.equal(child("cat package.json; tee package.json < /dev/null"), "deny");
  assert.equal(child("grep x package.json && sed -i 's/a/b/' package.json"), "deny");
});

test("an env prefix or wrapper on any reader, and a loop anywhere, end a protected read", { skip: !posix }, () => {
  const F = "package.json";
  for (const c of [
    `PATH=/tmp/e cat ${F}`,
    `PATH=/tmp/e grep x ${F}`,
    `LD_PRELOAD=/tmp/x.so cat ${F}`,
    `DYLD_INSERT_LIBRARIES=/tmp/x grep x ${F}`,
    `env cat ${F}`,
    `command cat ${F}`,
    `nice cat ${F}`,
    `for PATH in /tmp/e; do cat ${F}; done`,
    `for PATH in /tmp/e; do git diff -- ${F}; done`,
    `select PATH in /tmp/e; do grep x ${F}; done`,
    `for x in a; do cat ${F}; done`,
  ]) assert.equal(child(c), "deny", c);
  for (const c of [`cat ${F}`, `grep x ${F}`, `git diff a..b -- ${F}`, `git -C sub diff -- ${F}`, `cd sub && git diff -- ../${F}`]) assert.equal(child(c), "pass", c);
});

test("the protected read-only split holds for a child workspace under a `<repo>.worktrees/<x>` path", { skip: !posix }, () => {
  const inWorktree = childIn(path.join(base, "x.worktrees", "y"));
  for (const c of ["git diff -- package.json", "git log -p -- package.json", "grep x package.json", "cat package.json | head -2"]) assert.equal(inWorktree(c), "pass", c);
  for (const c of ["echo x > package.json", "sed -i 's/a/b/' package.json", "git checkout -- package.json"]) assert.equal(inWorktree(c), "deny", c);
});
