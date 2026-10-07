import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { mainNeedsGitGuard } from "../gitguard.ts";
import { appendReview, headOf, headsAt, isPrToolName, launchCwds, MAX_REVIEWS, passHeads, prToolRefusal, reviewedHead, reviewsOfRunEnd } from "../reviews.ts";
import type { ReviewRecord } from "../reviews.ts";

test("reviewsOfRunEnd: completed reviewer results with a verdict and their cwd", () => {
  const ok = reviewsOfRunEnd({ agent: "reviewer", status: "completed", cwd: "/w", output: "Overall verdict: PASS" });
  assert.deepEqual(ok, [{ role: "reviewer", verdict: "pass", cwd: "/w" }]);
  const grouped = reviewsOfRunEnd({ results: [{ agent: "senior-reviewer", status: "completed", cwd: "/a", output: "Verdict: BLOCK" }, { agent: "builder", status: "completed", output: "Verdict: PASS" }] });
  assert.deepEqual(grouped, [{ role: "senior-reviewer", verdict: "fail", cwd: "/a" }]);
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
    assert.equal((await prToolRefusal(dir, [newer], { head: "feat" }))?.reason, "stale_review");
    assert.equal((await prToolRefusal(dir, [newer], { sourceBranch: "owner:feat" }))?.reason, "stale_review");
    assert.equal(await prToolRefusal(dir, [head], { source_branch: "feat" }), null);
    assert.equal((await prToolRefusal(dir, [newer], { branch: "nosuch" }))?.reason, "head_unknown");
    assert.equal((await prToolRefusal(dir, [newer], { head_branch: 7 }))?.reason, "head_unknown");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
