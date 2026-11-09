import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { prGateRefusal, prToolRefusal } from "../reviews.ts";
import type { ReviewRecord } from "../reviews.ts";
import { rmTestTmp } from "./_tmpbase.ts";

type Rig = { root: string; main: string; wt: string; g: (cwd: string, ...a: string[]) => string; commit: (cwd: string, m: string) => string };

/** A bare origin, a main checkout at origin/main and a linked worktree on round/x created from origin/main (upstream = origin/main). */
function rig(): Rig {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-prhead-")));
  // the harness sets url.invalid-push:.pushInsteadOf for every URL; the fixture's own origin keeps its path
  const pushKeep = `url.${path.join(root, "origin.git")}.pushInsteadOf=${path.join(root, "origin.git")}`;
  const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", pushKeep, ...a], { encoding: "utf8" }).trim();
  const commit = (cwd: string, m: string) => {
    g(cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", m);
    return g(cwd, "rev-parse", "HEAD");
  };
  const origin = path.join(root, "origin.git");
  const main = path.join(root, "main");
  const wt = path.join(root, "wt");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, main], { stdio: "ignore" });
  commit(main, "chore: base");
  g(main, "push", "-q", "origin", "main");
  g(main, "fetch", "-q", "origin");
  g(main, "worktree", "add", "-q", "-b", "round/x", wt, "origin/main");
  return { root, main, wt, g, commit };
}

const rec = (cwd: string, head: string): ReviewRecord => ({ role: "reviewer", verdict: "pass", head, cwd });

test("worktree branch from origin/main, pushed without -u: a PASS on its head opens the gate", async () => {
  const r = rig();
  try {
    const head = r.commit(r.wt, "feat: x");
    r.g(r.wt, "push", "-q", "origin", "round/x");
    const gate = (cwd: string, reviewed: string[], checkout?: { cwd: string; records: ReviewRecord[] }, input: Record<string, unknown> = {}) =>
      prGateRefusal({ tool: "pr_create", isChild: false, gateOn: true, reviewed, cwd, input, checkout });
    assert.equal(await gate(r.wt, [head]), null);
    assert.equal(await gate(r.main, [], { cwd: r.wt, records: [rec(r.wt, head)] }), null);
    assert.equal(await prToolRefusal(r.main, [head], { head: "round/x" }), null);
    assert.equal(await prToolRefusal(r.wt, [head], { head: "round/x" }), null);
  } finally {
    rmTestTmp(r.root);
  }
});

test("a PASS on origin/main's sha does not open the gate for a worktree branch at another head", async () => {
  const r = rig();
  try {
    const base = r.g(r.main, "rev-parse", "HEAD");
    const head = r.commit(r.wt, "feat: x");
    r.g(r.wt, "push", "-q", "origin", "round/x");
    assert.notEqual(base, head);
    assert.equal((await prGateRefusal({ tool: "pr_create", isChild: false, gateOn: true, reviewed: [base], cwd: r.wt }))?.reason, "stale_review");
    assert.equal((await prGateRefusal({ tool: "pr_create", isChild: false, gateOn: true, reviewed: [], cwd: r.main, checkout: { cwd: r.wt, records: [rec(r.main, base)] } }))?.reason, "cwd_unreviewed");
    assert.equal((await prToolRefusal(r.wt, [base], { head: "round/x" }))?.reason, "stale_review");
    // detached HEAD at the worktree head: no branch, no remote counterpart; the PASS on the base stays refused
    r.g(r.wt, "checkout", "-q", "--detach");
    assert.equal((await prToolRefusal(r.wt, [base]))?.reason, "stale_review");
  } finally {
    rmTestTmp(r.root);
  }
});

test("same-named upstream: ahead and unreviewed refuses; local behind a reviewed origin/<branch> accepts", async () => {
  const r = rig();
  try {
    const head = r.commit(r.wt, "feat: x");
    r.g(r.wt, "push", "-q", "-u", "origin", "round/x");
    // another clone pushes a newer commit to origin/round/x
    const other = path.join(r.root, "other");
    execFileSync("git", ["clone", "-q", "-b", "round/x", path.join(r.root, "origin.git"), other], { stdio: "ignore" });
    const newer = r.commit(other, "feat: y");
    r.g(other, "push", "-q", "origin", "round/x");
    r.g(r.wt, "fetch", "-q", "origin");
    const gate = (reviewed: string[], input: Record<string, unknown> = {}) => prToolRefusal(r.wt, reviewed, input);
    assert.equal((await gate([head]))?.reason, "stale_review");
    assert.equal((await gate([head], { head: "round/x" }))?.reason, "stale_review");
    assert.equal(await gate([head, newer]), null);
    assert.equal(await gate([newer]), null);
  } finally {
    rmTestTmp(r.root);
  }
});

test("from the main checkout a named head opens only via its own commit, never via the checkout's HEAD", async () => {
  const r = rig();
  try {
    const base = r.g(r.main, "rev-parse", "HEAD");
    const head = r.commit(r.wt, "feat: x");
    r.g(r.wt, "push", "-q", "origin", "round/x");
    for (const input of [{ head: "round/x" }, { head: "owner:round/x" }, { source_branch: "round/x" }]) {
      assert.equal((await prToolRefusal(r.main, [base], input))?.reason, "stale_review", JSON.stringify(input));
      assert.equal((await prGateRefusal({ tool: "pr_create", isChild: false, gateOn: true, reviewed: [base], cwd: r.main, input }))?.reason, "stale_review");
      assert.equal(await prToolRefusal(r.main, [head], input), null, JSON.stringify(input));
    }
    assert.equal(await prToolRefusal(r.main, [base]), null);
  } finally {
    rmTestTmp(r.root);
  }
});
