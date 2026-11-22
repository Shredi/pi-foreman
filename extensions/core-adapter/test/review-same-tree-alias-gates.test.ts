// D117 revision: an alias made BEFORE a high-stakes FAIL stops counting at the gates (reviewcover.ts liveRecords), and a record's time is the reviewer's launch time.
// Real git worktrees; the PR gate for other packages' PR tools is the probe.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { commitTreeNoWorkflow } from "../commentonly.ts";
import { buildCeremonyState, CEREMONY_ENTRY } from "../planstate.ts";
import type { ReviewRecord } from "../reviews.ts";
import { rmTestTmp } from "./_tmpbase.ts";
import { world } from "./_r46world.ts";
import { execFileSync } from "node:child_process";

import { liveRecords } from "../reviewcover.ts";

async function preAliasCase(t: Parameters<typeof world>[0], cleared: "no" | "other", freshPass: boolean): Promise<{ reason: string }> {
  const w = world(t, { realSnapshot: true });
  const dir = w.project;
  fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
  const git = (d: string, ...a: string[]) => execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "base");
  const B = fs.realpathSync.native(dir);
  const h1 = git(B, "rev-parse", "HEAD");
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-hsalias-")));
  try {
    const C = path.join(tmp, "c");
    git(B, "worktree", "add", "-q", C, "-b", "cbr");
    git(C, "commit", "-q", "--allow-empty", "-m", "y");
    const Y = git(C, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(C, "z.txt"), "z\n");
    git(C, "add", "z.txt");
    git(C, "commit", "-q", "-m", "z");
    const Z = git(C, "rev-parse", "HEAD");
    git(C, "reset", "-q", "--hard", Y);
    git(C, "commit", "-q", "--amend", "--allow-empty", "-m", "y amended");
    const X = git(C, "rev-parse", "HEAD");
    git(C, "branch", "-f", "old", X);
    const tree = (await commitTreeNoWorkflow(B, h1))!;
    const pass = (at: number): ReviewRecord => ({ role: "reviewer", verdict: "pass", head: h1, cwd: B, kind: "code", occasion: "pre-pr", tree, at });
    const alias = (at: number): ReviewRecord => ({ ...pass(at), head: X, via: "same_tree" });
    const reviews = [pass(1000), alias(1000), ...(freshPass ? [pass(3000), alias(3000)] : [])];
    const run = { verdict: "fail" as const, head: Y, cwd: fs.realpathSync.native(C), failAt: 2000, revised: false, handed: false, cleared: cleared !== "no", clearedAt: cleared === "other" ? Z : undefined };
    const hs = { fired: { reasons: ["design"] }, runIds: [], runs: [run], bases: {} };
    w.entries.push({ type: "custom", customType: CEREMONY_ENTRY, data: buildCeremonyState({ plan: null, lineages: [], planPhase: false, reviews, highStakes: hs }) });
    const a = await w.adapter("startup");
    const reason = (await a.checkCall("create_pull_request", { head: "old" }))?.reason ?? "";
    await a.down();
    return { reason };
  } finally {
    rmTestTmp(tmp);
  }
}

test("an alias made before an uncleared high-stakes FAIL no longer opens the PR gate", async (t) => {
  assert.notEqual((await preAliasCase(t, "no", false)).reason, "");
});

test("an alias made before a high-stakes FAIL cleared at another tree no longer opens the PR gate", async (t) => {
  assert.notEqual((await preAliasCase(t, "other", false)).reason, "");
});

test("a fresh PASS and alias after the cleared FAIL open the PR gate again", async (t) => {
  assert.equal((await preAliasCase(t, "other", true)).reason, "");
});

test("liveRecords drops an alias whose time is not after the newest FAIL, and every alias while a FAIL is uncleared", () => {
  const base = { role: "reviewer", verdict: "pass", head: "a", kind: "code" } as ReviewRecord;
  const al = (at: number): ReviewRecord => ({ ...base, head: "b", via: "same_tree", at });
  const run = (cleared: boolean) => [{ verdict: "fail", cleared, failAt: 2000 }];
  assert.equal(liveRecords([base, al(3000)], run(true)).length, 2);
  assert.equal(liveRecords([base, al(1500)], run(true)).length, 1);
  assert.equal(liveRecords([base, al(3000)], run(false)).length, 1);
  assert.equal(liveRecords([base, al(1500)], []).length, 2);
});
