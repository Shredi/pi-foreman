// Own-worktree path comparison (ownworktree.ts) and the Head line of the reviewer output file (reviews.ts).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ownWorktreeCheck, pathKey, pathWithin } from "../ownworktree.ts";
import { appendHeadLine, headLine, lastHeadLine, reviewedHeadWhy, reviewsWithOutput as reviewsOfRunEnd } from "../reviews.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf-ownwt-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const id = (p: string): string => p;

test("pathKey / pathWithin: win32 compares case-folded with either separator", () => {
  assert.equal(pathKey("C:/Work/Repo.worktrees/B/", "win32"), pathKey("c:\\work\\repo.worktrees\\b", "win32"));
  assert.ok(pathWithin("C:\\Work\\Repo.worktrees\\B", "c:/work/repo.worktrees/b/src", "win32"));
  assert.ok(!pathWithin("C:\\Work\\Repo.worktrees\\B", "C:\\Work\\Repo.worktrees\\Bb", "win32"));
});

test("pathKey / pathWithin: darwin folds case, linux does not", () => {
  assert.ok(pathWithin("/Work/Wt", "/work/wt/src", "darwin"));
  assert.ok(!pathWithin("/Work/Wt", "/work/wt/src", "linux"));
  assert.ok(!pathWithin("/work/wt", "/work/wt-2", "linux"));
});

test("ownWorktreeCheck: a root, its subdirs and its real spelling are own; a sibling or a nested worktree is not", () => {
  const real = (p: string): string => p.replace("/link/", "/real/");
  const top = (d: string): string | null => (d.startsWith("/real/wt/nested") ? "/real/wt/nested" : d.startsWith("/real/wt") ? "/real/wt" : d.startsWith("/real/other") ? "/real/other" : null);
  const own = ownWorktreeCheck(["/link/wt"], "linux", real, top);
  assert.ok(own("/link/wt"));
  assert.ok(own("/link/wt/sub"));
  assert.ok(own("/real/wt"));
  assert.ok(!own("/link/wt/nested/src"));
  assert.ok(!own("/link/other"));
  assert.ok(!own("/link/nowhere"));
  assert.ok(!ownWorktreeCheck([], "linux", id, top)("/link/wt"));
});

test("headLine: the full sha, or unknown with the why", () => {
  const sha = "a".repeat(40);
  assert.equal(headLine({ head: sha }), `Head: ${sha}`);
  assert.equal(headLine({ head: null, why: "head_moved" }), "Head: unknown (head_moved)");
  assert.equal(headLine(reviewedHeadWhy(undefined, "/w", null)), "Head: unknown (no_launch_head)");
});

test("appendHeadLine: the Head line becomes the last line; a missing file is not created", () => {
  const f = path.join(base, "r1_reviewer_output.md");
  fs.writeFileSync(f, "Overall verdict: PASS");
  assert.ok(appendHeadLine(f, { head: "b".repeat(40) }));
  assert.equal(fs.readFileSync(f, "utf8"), `Overall verdict: PASS\nHead: ${"b".repeat(40)}\n`);
  const g = path.join(base, "r2_reviewer_output.md");
  fs.writeFileSync(g, "Verdict: FAIL\n");
  assert.ok(appendHeadLine(g, { head: null, why: "head_unread" }));
  assert.equal(fs.readFileSync(g, "utf8"), "Verdict: FAIL\nHead: unknown (head_unread)\n");
  const none = path.join(base, "missing.md");
  assert.equal(appendHeadLine(none, { head: null }), false);
  assert.ok(!fs.existsSync(none));
});

test("lastHeadLine: the last match wins over a Head line the reviewer wrote", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  assert.equal(lastHeadLine(`Head: ${a}\nPASS\nHead: ${b}\n`), b);
  assert.equal(lastHeadLine(`Head: ${a}\nPASS\nHead: unknown (head_moved)\n`), "unknown");
  assert.equal(lastHeadLine("PASS\n"), null);
});

test("reviewsOfRunEnd: the output file path of the result rides along when present", () => {
  const r = reviewsOfRunEnd({ agent: "reviewer", status: "completed", cwd: "/w", output: "Overall verdict: PASS", artifactPaths: { outputPath: "/a/run_reviewer_output.md" } });
  assert.deepEqual(r, [{ role: "reviewer", verdict: "pass", cwd: "/w", outputPath: "/a/run_reviewer_output.md" }]);
});
