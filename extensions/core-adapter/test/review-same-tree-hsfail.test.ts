// D117 revision: a same-tree alias is not made when the tree of `head` equals the tree of an uncleared high-stakes FAIL of another checkout (an amend of that FAIL's commit).
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
import { tick, world } from "./_r46world.ts";
import { execFileSync } from "node:child_process";

async function amendCase(t: Parameters<typeof world>[0], cleared: "no" | "other" | "same", o: { passAt?: number; removeC?: boolean } = {}): Promise<{ reason: string; alias: boolean }> {
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
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-hsamend-")));
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
    assert.notEqual(X, Y);
    const tree = (await commitTreeNoWorkflow(B, h1))!;
    assert.equal(await commitTreeNoWorkflow(B, X), tree);
    const rec: ReviewRecord = { role: "reviewer", verdict: "pass", head: h1, cwd: B, kind: "code", occasion: "pre-pr", tree, at: o.passAt ?? 1000 };
    const run = { verdict: "fail" as const, head: Y, cwd: fs.realpathSync.native(C), failAt: 2000, revised: false, handed: false, cleared: cleared !== "no", clearedAt: cleared === "other" ? Z : cleared === "same" ? Y : undefined };
    if (o.removeC) git(B, "worktree", "remove", "--force", C);
    const hs = { fired: { reasons: ["design"] }, runIds: [], runs: [run], bases: {} };
    w.entries.push({ type: "custom", customType: CEREMONY_ENTRY, data: buildCeremonyState({ plan: null, lineages: [], planPhase: false, reviews: [rec], highStakes: hs }) });
    const a = await w.adapter("startup");
    const reason = (await a.checkCall("create_pull_request", { head: "cbr" }))?.reason ?? "";
    await tick(100);
    const recs = ((w.ceremonyEntries().at(-1)?.data ?? {}) as { reviews?: ReviewRecord[] }).reviews ?? [];
    await a.down();
    return { reason, alias: recs.some((r) => r.head === X && r.via === "same_tree") };
  } finally {
    rmTestTmp(tmp);
  }
}

test("an amend in a sibling worktree of an uncleared high-stakes FAIL's commit gets no alias of a PASS on the same tree in another checkout", async (t) => {
  const r = await amendCase(t, "no");
  assert.equal(r.alias, false);
  assert.notEqual(r.reason, "", "the PR is refused");
});

test("a high-stakes FAIL cleared at a head of another tree still blocks the alias on its tree", async (t) => {
  const r = await amendCase(t, "other");
  assert.equal(r.alias, false);
  assert.notEqual(r.reason, "", "the PR is refused");
});

test("a high-stakes FAIL cleared at a head of the same tree still blocks the alias of a PASS older than that FAIL", async (t) => {
  const r = await amendCase(t, "same");
  assert.equal(r.alias, false);
});

test("an uncleared high-stakes FAIL whose checkout was removed gives no alias", async (t) => {
  const r = await amendCase(t, "no", { removeC: true });
  assert.equal(r.alias, false);
  assert.notEqual(r.reason, "", "the PR is refused");
});

test("an uncleared high-stakes FAIL of reviewed uncommitted content, committed later in its checkout, gives no alias", async (t) => {
  const r = await amendCase(t, "no", { passAt: 3000 });
  assert.equal(r.alias, false);
  assert.notEqual(r.reason, "", "the PR is refused");
});

test("a PASS made after the cleared high-stakes FAIL still gets the alias", async (t) => {
  const r = await amendCase(t, "same", { passAt: 3000 });
  assert.equal(r.alias, true);
  assert.equal(r.reason, "");
});
