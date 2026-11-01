import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { mainNeedsGitGuard } from "../gitguard.ts";
import { appendReview, headOf, headsAt, isPrToolName, launchCwds, MAX_REVIEWS, passHeads, prGateRefusal, prToolRefusal, checksLine, reviewedHead, reviewsOfRunEnd } from "../reviews.ts";
import type { ReviewRecord } from "../reviews.ts";
import { rmTestTmp } from "./_tmpbase.ts";

test("reviewsOfRunEnd: completed reviewer results with a verdict and their cwd", () => {
  const ok = reviewsOfRunEnd({ agent: "reviewer", status: "completed", cwd: "/w", output: "Overall verdict: PASS" });
  assert.deepEqual(ok, [{ role: "reviewer", verdict: "pass", cwd: "/w" }]);
  const grouped = reviewsOfRunEnd({ results: [{ agent: "reviewer", status: "completed", cwd: "/a", output: "Verdict: BLOCK" }, { agent: "builder", status: "completed", output: "Verdict: PASS" }] });
  assert.deepEqual(grouped, [{ role: "reviewer", verdict: "fail", cwd: "/a" }]);
  assert.deepEqual(reviewsOfRunEnd({ agent: "reviewer", status: "failed", output: "Overall verdict: PASS" }), []);
  assert.deepEqual(reviewsOfRunEnd({ agent: "reviewer", status: "completed", output: "no verdict" }), []);
  assert.deepEqual(reviewsOfRunEnd(null), []);
});

test("appendReview caps at 50; passHeads keeps only heads whose latest verdict is PASS", () => {
  const list: ReviewRecord[] = [];
  for (let i = 0; i < MAX_REVIEWS + 5; i++) appendReview(list, { role: "reviewer", verdict: "pass", head: String(i).padStart(40, "a") });
  assert.equal(list.length, MAX_REVIEWS);
  assert.equal(list[0].head, "5".padStart(40, "a"));
  const mixed: ReviewRecord[] = [
    { role: "reviewer", verdict: "pass", head: "a".repeat(40) },
    { role: "reviewer", verdict: "pass", head: "b".repeat(40) },
    { role: "reviewer", verdict: "fail", head: "b".repeat(40) },
    { role: "reviewer", verdict: "pass", head: null },
  ];
  assert.deepEqual(passHeads(mixed), ["a".repeat(40)]);
});

test("isPrToolName and the widened git-guard fast path", () => {
  for (const n of ["github_create_pr", "create_pull_request", "gitlab-merge_request-open", "pr_create"]) assert.equal(isPrToolName(n), true, n);
  for (const n of ["createPullRequest", "openMergeRequest", "gitlab_create_mr", "createPR"]) assert.equal(isPrToolName(n), true, n);
  for (const n of ["pr_list", "create_issue", "express_create", "subagent", "bash", "listPullRequests", "mrs_create"]) assert.equal(isPrToolName(n), false, n);
  for (const c of ["gh pr create", "glab mr create", "hub pull-request", "tea pr create", "git push"]) assert.equal(mainNeedsGitGuard(c), true, c);
  assert.equal(mainNeedsGitGuard("ls -la"), false);
  assert.equal(mainNeedsGitGuard("echo ghost"), false);
});

test("headOf and prToolRefusal against a real repository, and head_unknown outside one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-reviews-"));
  try {
    assert.equal(await headOf(dir), null);
    assert.equal((await prToolRefusal(dir, []))?.reason, "head_unknown");
    const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
    g("init", "-q");
    g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "chore: x");
    const head = g("rev-parse", "HEAD");
    assert.equal(await headOf(dir), head);
    assert.equal((await prToolRefusal(dir, []))?.reason, "no_review");
    assert.equal((await prToolRefusal(dir, ["f".repeat(40)]))?.reason, "stale_review");
    assert.equal(await prToolRefusal(dir, [head]), null);
    // B-M7: a branch argument is resolved in the workspace and must be a reviewed head.
    g("branch", "feat");
    g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "chore: y");
    const newer = g("rev-parse", "HEAD");
    // r29 item 1: the reviewed HEAD accepts a branch argument whose own ref is older (the ruling).
    assert.equal(await prToolRefusal(dir, [newer], { head: "feat" }), null);
    assert.equal(await prToolRefusal(dir, [newer], { sourceBranch: "owner:feat" }), null);
    assert.equal(await prToolRefusal(dir, [head], { source_branch: "feat" }), null);
    assert.equal((await prToolRefusal(dir, [newer], { branch: "nosuch" }))?.reason, "head_unknown");
    assert.equal((await prToolRefusal(dir, [newer], { head_branch: 7 }))?.reason, "head_unknown");
  } finally {
    rmTestTmp(dir);
  }
});

test("reviewedHead keeps a head only when HEAD at launch equals HEAD at run end (B-M4)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-reviews-"));
  try {
    const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
    g("init", "-q");
    const commit = () => g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "chore: x");
    commit();
    assert.deepEqual(launchCwds({ agent: "reviewer", tasks: [{ agent: "reviewer", cwd: "sub" }] }, dir), [path.resolve(dir), path.resolve(dir, "sub")]);
    const start = await headsAt(launchCwds({ agent: "reviewer" }, dir));
    const atStart = g("rev-parse", "HEAD");
    assert.equal(reviewedHead(start, dir, await headOf(dir)), atStart);
    commit(); // a commit while the reviewer ran
    assert.equal(reviewedHead(start, dir, await headOf(dir)), null);
    assert.equal(reviewedHead(undefined, dir, atStart), null);
    assert.equal(reviewedHead(start, dir, null), null);
  } finally {
    rmTestTmp(dir);
  }
});

test("prGateRefusal: child, gate off, and a pushed upstream that was not reviewed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-reviews-"));
  try {
    assert.equal((await prGateRefusal({ tool: "pr_create", isChild: true, gateOn: false, reviewed: [], cwd: dir }))?.reason, "child");
    assert.equal(await prGateRefusal({ tool: "pr_create", isChild: false, gateOn: false, reviewed: [], cwd: dir }), null);
    const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
    g("init", "-q");
    const commit = (m: string) => g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", m);
    commit("chore: a");
    const first = g("rev-parse", "HEAD");
    const branch = g("symbolic-ref", "--short", "HEAD");
    g("update-ref", "refs/remotes/origin/" + branch, first);
    g("config", "remote.origin.url", "https://h.invalid/r.git");
    g("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    g("config", "branch." + branch + ".remote", "origin");
    g("config", "branch." + branch + ".merge", "refs/heads/" + branch);
    commit("chore: b");
    const second = g("rev-parse", "HEAD");
    const gate = (reviewed: string[]) => prGateRefusal({ tool: "pr_create", isChild: false, gateOn: true, reviewed, cwd: dir });
    assert.equal((await gate([second]))?.reason, "stale_review");
    assert.equal(await gate([second, first]), null);
  } finally {
    rmTestTmp(dir);
  }
});

test("prToolRefusal accepts the reviewed sha via the local ref, origin/<b>, or HEAD (r29 item 1)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-reviews-"));
  try {
    const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
    g("init", "-q");
    const commit = () => g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "chore: x");
    commit();
    const a = g("rev-parse", "HEAD");
    commit();
    const b = g("rev-parse", "HEAD");
    commit();
    const c = g("rev-parse", "HEAD");
    g("branch", "feat", a); // the local ref lags; HEAD is c
    assert.equal(await prToolRefusal(dir, [a], { head: "feat" }), null, "local ref");
    assert.equal(await prToolRefusal(dir, [c], { head: "feat" }), null, "HEAD only");
    g("update-ref", "refs/remotes/origin/feat", b); // the push that carries b
    assert.equal(await prToolRefusal(dir, [b], { head: "feat" }), null, "origin/feat only");
    const f = "f".repeat(40);
    const refused = await prToolRefusal(dir, [f], { head: "feat" });
    assert.equal(refused?.reason, "stale_review");
    assert.ok(refused?.message.includes(`PASS ${f}, head ${a}`), refused?.message);
  } finally {
    rmTestTmp(dir);
  }
});

test("checksLine: one line only when a check failed", () => {
  assert.equal(checksLine(null), "");
  assert.equal(checksLine({ failed: [], pending: [], summary: "1 passed" }), "");
  assert.match(checksLine({ failed: [{ name: "ci" }], pending: [], summary: "0 passed, 1 failed (ci), 0 pending" }), /^PR checks: 0 passed, 1 failed \(ci\), 0 pending\. Failed checks block a merge/);
});
