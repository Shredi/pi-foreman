// D62+ review fix: the reviewed state the progress rule compares leaves out `.workflow/`, so a builder run that only touched the ledger
// (the harness writes launch notes there when a repo does not ignore it) is no progress.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { worktreeTree } from "../commentonly.ts";
import { sharedWorld } from "./_r46world.ts";
import { lightSpawner } from "./_light-spawner.ts";
import { codeReview, loopRefused } from "./_loopstop.ts";

function repo(dir: string): void {
  fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.autocrlf=false", ...a], { encoding: "utf8" });
  git("init", "-q");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "base");
}

const shared = sharedWorld({ ceremony: { default: "standard" }, spawner: lightSpawner({ memoConfig: true, noFindings: true }) }, async (w) => repo(w.project));
const reportItem = (n: number, note: string): string => `${n}. FAIL: ${note}\nOverall verdict: FAIL`;

test("worktreeTree(skipWorkflow): .workflow changes do not move the tree, other changes do", async () => {
  const w = await shared();
  const ledger = path.join(w.project, ".workflow", "LEDGER-x.md");
  const before = await worktreeTree(w.project, true);
  assert.ok(before);
  fs.writeFileSync(ledger, "- [ ] 1. note\n");
  assert.equal(await worktreeTree(w.project, true), before);
  assert.notEqual(await worktreeTree(w.project), before, "the plain snapshot sees the ledger");
  fs.writeFileSync(path.join(w.project, "a.txt"), "changed\n");
  assert.notEqual(await worktreeTree(w.project, true), before);
});

test(".workflow not ignored: a builder run that only appends to the ledger between two item-only FAILs is no progress: stop", async () => {
  const w = await shared();
  const ledger = path.join(w.project, ".workflow", "LEDGER-x.md");
  assert.ok(!fs.existsSync(path.join(w.project, ".gitignore")), ".workflow is not ignored");
  const a = await w.adapter("startup");
  assert.equal(await codeReview(a, reportItem(2, "x"), 1), null);
  assert.equal(await a.launch("builder"), undefined);
  fs.appendFileSync(ledger, "- launch note\n");
  assert.equal(await codeReview(a, reportItem(2, "y"), 2), null);
  assert.equal((await w.traceEvents()).filter((r) => r.event === "review_loop").length, 1);
  assert.ok(loopRefused(await a.launch("builder")));
});
