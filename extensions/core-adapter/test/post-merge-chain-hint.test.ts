// The post-merge chain guard: near-miss shapes stay refused and carry a hint naming the accepted chain (chainHint); the base stays the remote default branch.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { branchMove, chainHint } from "../shellwriteguard.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

function fixture() {
  const base = fs.realpathSync.native(mkTestTmp("pf-chainhint-"));
  const origin = path.join(base, "origin.git");
  const work = path.join(base, "work");
  const g = (...a: string[]) => execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", `url.${origin}.pushInsteadOf=${origin}`, ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "--bare", origin]);
  fs.mkdirSync(work);
  execFileSync("git", ["init", "-q", work]);
  g("checkout", "-q", "-b", "main");
  fs.writeFileSync(path.join(work, "README.md"), "one\n");
  g("add", "README.md");
  g("commit", "-q", "-m", "chore: one");
  g("remote", "add", "origin", origin);
  g("push", "-q", "-u", "origin", "main");
  g("remote", "set-head", "origin", "main");
  g("switch", "-q", "-c", "round/1-x");
  return { base, work, g };
}

// one repository for the tests that only read it (few git starts: the suite has a child-process budget)
let common: ReturnType<typeof fixture> | undefined;
const shared = () => (common ??= fixture());
after(() => {
  if (common) rmTestTmp(common.base);
});

const NEAR_MISSES = [
  "git switch main && git reset --hard origin/main",
  "git switch main && git pull",
  "git switch main && git pull --ff-only && git branch -D a b",
  "git switch main && git pull --ff-only && rm -rf x",
  "git switch main && git clean -fd",
  "git switch main; git pull --ff-only",
  "git checkout main && git pull --ff-only origin main",
  "git switch main && git pull --ff-only && git fetch --prune",
  "git switch main && git pull --ff-only | cat",
  "cd . && git switch main && git reset --hard origin/main",
];

test("near-miss chains stay refused (branchMove null) and carry the hint", async () => {
  const f = shared();
  for (const c of NEAR_MISSES) {
    assert.equal(await branchMove(c, f.work, true), null, c);
    const hint = chainHint(c, true);
    assert.ok(hint, c);
    assert.match(hint, /git switch <default> && git pull --ff-only/);
    assert.match(hint, /remote default branch/);
  }
  assert.equal(await branchMove("git switch main\ngit pull --ff-only", f.work, true), null);
});

test("no hint for other lines, flags on the switch, or a child", () => {
  for (const c of ["git switch main", "git status && git switch main", "git switch -f x && git pull --ff-only", "git switch -C x && git pull", "ls && rm -rf x", "git reset --hard origin/main && git switch main"]) {
    assert.equal(chainHint(c, true), null, c);
  }
  assert.equal(chainHint(NEAR_MISSES[0], false), null, "children get nothing");
});

test("the accepted chain, a force switch, a missing branch, a dirty tree, a `;` chain and a child", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await branchMove("git switch main && git pull --ff-only", f.work, true), { allow: true, reason: "post_merge" });
    assert.equal(await branchMove("git switch -f main", f.work, true), null);
    assert.equal(await branchMove("git switch -f main && git pull --ff-only", f.work, true), null);
    assert.equal(await branchMove("git switch main; git pull --ff-only", f.work, true), null);
    assert.equal(await branchMove("git switch main && git pull --ff-only", f.work, false), null, "children never");
    f.g("remote", "set-head", "origin", "main");
    const missing = await branchMove("git switch gone && git pull --ff-only", f.work, true);
    assert.equal(missing?.allow, false);
    fs.writeFileSync(path.join(f.work, "README.md"), "dirty\n");
    assert.deepEqual(await branchMove("git switch main && git pull --ff-only", f.work, true), { allow: false, precondition: "working tree not clean" });
  } finally {
    rmTestTmp(f.base);
  }
});

test("a base that is not the remote default stays refused, and says which branch is the default", async () => {
  const f = shared();
  f.g("branch", "-f", "other");
  assert.deepEqual(await branchMove("git switch other && git pull --ff-only", f.work, true), { allow: false, precondition: "other is not the default branch main" });
});

test("an unset origin/HEAD refuses the chain with a precondition that says how to set it", async () => {
  const f = fixture();
  try {
    f.g("remote", "set-head", "origin", "-d");
    const r = await branchMove("git switch main && git pull --ff-only", f.work, true);
    assert.equal(r?.allow, false);
    assert.match(r && "precondition" in r ? r.precondition : "", /origin\/HEAD is not set.*git remote set-head origin -a/);
  } finally {
    rmTestTmp(f.base);
  }
});
