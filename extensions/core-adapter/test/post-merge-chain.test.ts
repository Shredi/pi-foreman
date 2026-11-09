// Auto-merge: the post-merge chain (`git switch <default> && git pull --ff-only [&& git branch -d|-D <b>]`) in the shell-write guard's branchMove,
// the `git branch -d|-D <b>` default for a merged branch, and branchMergedFact. Temp repos with a bare origin; gh is an injected runner.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { branchMergedFact, branchMove, setGhRunnerForTest } from "../shellwriteguard.ts";
import { gateDecide, gateEvaluate, type GateResult } from "../gate.ts";
import { mergedFactKey, withMergedFacts, type GitFacts } from "../defaults.ts";
import type { GateRoots } from "../pathrules.ts";
import type { FloorEnv } from "../floors.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

before(() => setGhRunnerForTest(async () => ({ ok: false, out: "" })));
after(() => setGhRunnerForTest(null));

const cdWord = (dir: string) => dir.split(path.sep).join("/");

function fixture() {
  const base = fs.realpathSync.native(mkTestTmp("pf-postmerge-"));
  const origin = path.join(base, "origin.git");
  const work = path.join(base, "work");
  const g = (...a: string[]) => execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "--bare", origin]);
  fs.mkdirSync(work);
  execFileSync("git", ["init", "-q", work]);
  g("checkout", "-q", "-b", "main");
  fs.writeFileSync(path.join(work, "README.md"), "one\n");
  g("add", "README.md");
  g("commit", "-q", "-m", "chore: one");
  g("remote", "add", "origin", origin);
  g("-c", `url.${origin}.pushInsteadOf=${origin}`, "push", "-q", "-u", "origin", "main");
  g("remote", "set-head", "origin", "main");
  g("switch", "-q", "-c", "round/1-x");
  return { base, work, g };
}

test("post-merge chain: switch, pull and delete are allowed with reason post_merge", async () => {
  const f = fixture();
  try {
    for (const c of ["git switch main && git pull --ff-only", "git switch main && git pull --ff-only && git branch -d round/1-x", "git switch main && git pull --ff-only && git branch -D round/1-x", `cd ${cdWord(f.work)} && git switch main && git pull --ff-only && git branch -d round/1-x`]) {
      assert.deepEqual(await branchMove(c, f.work, true), { allow: true, reason: "post_merge" }, c);
    }
  } finally {
    rmTestTmp(f.base);
  }
});

test("post-merge chain: a dirty tree, another target and extra statements are refused or not this shape", async () => {
  const f = fixture();
  try {
    f.g("branch", "other");
    const other = await branchMove("git switch other && git pull --ff-only", f.work, true);
    assert.equal(other?.allow, false);
    for (const c of ["git switch main && git pull", "git switch main && git pull --ff-only && git branch -d a b", "git switch main && git pull --ff-only && rm -rf x", "git switch main && git pull --ff-only; git branch -d round/1-x", "git switch main && git push", "git switch main && git pull --ff-only && git branch -m x"]) {
      assert.equal(await branchMove(c, f.work, true), null, c);
    }
    assert.equal(await branchMove("git switch main && git pull --ff-only", f.work, false), null, "children never");
    fs.writeFileSync(path.join(f.work, "README.md"), "dirty\n");
    const dirty = await branchMove("git switch main && git pull --ff-only", f.work, true);
    assert.deepEqual(dirty, { allow: false, precondition: "working tree not clean" });
  } finally {
    rmTestTmp(f.base);
  }
});

test("branchMergedFact: ancestor of origin/default, or a MERGED PR at the tip; otherwise false", async () => {
  const f = fixture();
  try {
    assert.equal(await branchMergedFact(f.work, "round/1-x"), true, "no commit of its own: contained in main");
    fs.writeFileSync(path.join(f.work, "a.txt"), "a\n");
    f.g("add", "a.txt");
    f.g("commit", "-q", "-m", "feat: a");
    assert.equal(await branchMergedFact(f.work, "round/1-x"), false);
    const tip = f.g("rev-parse", "round/1-x");
    setGhRunnerForTest(async () => ({ ok: true, out: JSON.stringify({ state: "MERGED", headRefOid: tip }) }));
    assert.equal(await branchMergedFact(f.work, "round/1-x"), true);
    setGhRunnerForTest(async () => ({ ok: true, out: JSON.stringify({ state: "MERGED", headRefOid: "0".repeat(40) }) }));
    assert.equal(await branchMergedFact(f.work, "round/1-x"), false, "a PR merged at another tip");
    setGhRunnerForTest(async () => ({ ok: true, out: JSON.stringify({ state: "OPEN", headRefOid: tip }) }));
    assert.equal(await branchMergedFact(f.work, "round/1-x"), false);
    assert.equal(await branchMergedFact(f.work, "nope"), false);
  } finally {
    setGhRunnerForTest(async () => ({ ok: false, out: "" }));
    rmTestTmp(f.base);
  }
});

// ---- the default rule through the gate

const base2 = fs.realpathSync(mkTestTmp("pf-postmerge-gate-"));
after(() => rmTestTmp(base2));
const roots = (o: Partial<GateRoots> = {}): GateRoots => ({ worktree: base2, scratch: [], tmp: [], scratchBase: path.join(base2, "s"), owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: false, ...o });
const env: FloorEnv = { cwd: base2, home: "/pf/home", agentDir: "/pf/agent", platform: process.platform, protectedBranches: ["trunk"], currentBranch: () => "round/1-x", remoteHead: () => "trunk", writeRoots: [base2] };
const facts = (o: Partial<GitFacts> = {}): GitFacts => ({ currentBranch: () => "round/1-x", protectedBranches: () => ["main", "master", "trunk"], pushConfigured: () => false, branchMerged: () => true, ...o });
const sh = (line: string, o: { r?: Partial<GateRoots>; f?: Partial<GitFacts> } = {}): GateResult => gateDecide("bash", { command: line }, base2, { env: () => env, roots: () => roots(o.r), facts: facts(o.f) });
const rule = (r: GateResult): string | null => (r && "allow" in r ? r.rule : null);

test("git branch -d|-D <b>: a default only for a merged, non-protected branch, never for a child", () => {
  assert.equal(rule(sh("git branch -d round/1-x")), "default-git-branch-merged");
  assert.equal(rule(sh("git branch -D round/1-x")), "default-git-branch-merged");
  assert.equal(rule(sh("git branch -d round/1-x", { f: { branchMerged: () => false } })), null);
  assert.equal(rule(sh("git branch -d round/1-x", { f: { branchMerged: undefined } })), null);
  for (const l of ["git branch -d main", "git branch -D trunk", "git branch -d a b", "git branch -d --force a", "git branch -d -r x", "git branch -d refs/heads/a", "git branch -d a..b", "git branch --delete a", "git branch -d"]) assert.equal(rule(sh(l)), null, l);
  assert.equal(rule(sh("git branch -d round/1-x", { r: { child: true, role: "builder" } })), null);
});

const dangerOf = (line: string, o: { r?: Partial<GateRoots>; f?: Partial<GitFacts>; cwd?: string } = {}): string | null =>
  gateEvaluate("bash", { command: line }, o.cwd ?? base2, { env: () => env, roots: () => roots(o.r), facts: facts(o.f) }).danger?.name ?? null;

const CHAIN = "git switch trunk && git pull --ff-only && git branch -D round/1-x";

test("full post-merge chain through gateEvaluate: no danger with the merged fact, danger-git without it", () => {
  assert.equal(dangerOf(CHAIN), null);
  assert.equal(dangerOf(CHAIN, { f: { branchMerged: () => false } }), "danger-git");
});

test("git branch -D in a work folder outside the worktree is barred even with the merged fact", () => {
  const wf = fs.realpathSync.native(mkTestTmp("pf-postmerge-wf-"));
  try {
    const r: Partial<GateRoots> = { workFolders: [{ path: wf, mode: "auto" }] };
    const out = gateEvaluate("bash", { command: "git branch -D round/1-x" }, wf, { env: () => env, roots: () => roots(r), facts: facts() });
    assert.notEqual(out.result && "allow" in out.result ? out.result.rule : null, "default-git-branch-merged");
    assert.notEqual(out.danger, null, "no default applies, so the call falls into the dangerous class");
    assert.equal(dangerOf("git branch -D round/1-x", { r }), null, "the worktree itself stays allowed");
  } finally {
    rmTestTmp(wf);
  }
});

test("the merged fact is keyed per (cwd, branch): a fact for cwdA is not used in cwdB", () => {
  const a = path.join(base2, "a");
  const b = path.join(base2, "b");
  const gf = withMergedFacts(facts(), new Map([[mergedFactKey(a, "round/1-x"), true]]));
  assert.equal(gf.branchMerged?.(a, "round/1-x"), true);
  assert.equal(gf.branchMerged?.(b, "round/1-x"), false);
  assert.equal(gf.branchMerged?.(a, "round/2-y"), false);
});

test("git branch -D Main / MASTER / Trunk are protected case-insensitively on darwin and win32 only", () => {
  const ruleOn = (platform: string, line: string): string | null => {
    const e = { ...env, platform };
    return rule(gateDecide("bash", { command: line }, base2, { env: () => e, roots: () => roots(), facts: facts() }));
  };
  for (const p of ["darwin", "win32"]) for (const l of ["git branch -D Main", "git branch -D MASTER", "git branch -D Trunk"]) assert.equal(ruleOn(p, l), null, `${p} ${l}`);
  assert.equal(ruleOn("linux", "git branch -D Main"), "default-git-branch-merged");
});
