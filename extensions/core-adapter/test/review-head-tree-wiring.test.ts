// The launch snapshot is a dependency of the reviewer launch path (index.ts `worktreeSnapshot`): the shared rigs pass a no-op, the
// real entry point (no dependency given) takes the real snapshot, and a missing or no-op snapshot never accepts a moved head.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { headOf, headsAt, reviewedHeadVia, treesAt } from "../reviews.ts";
import { tick, world } from "./_r46world.ts";

function repo(dir: string): { git: (...a: string[]) => string } {
  fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.autocrlf=false", ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "base");
  return { git };
}

/** A reviewer launch over a dirty tree, a same-content commit, then a PASS: the `review_recorded` record. */
async function recorded(t: Parameters<typeof world>[0], realSnapshot: boolean): Promise<Record<string, unknown>> {
  const w = world(t, { realSnapshot });
  const g = repo(w.project);
  const a = await w.adapter("startup");
  fs.writeFileSync(path.join(w.project, "a.txt"), "a2\n");
  const r = await a.reviewLaunch("[pre-pr] review the branch");
  assert.ok(!r.blocked, r.blocked ?? "");
  g.git("add", "-A");
  g.git("commit", "-q", "-m", "work");
  a.endRun(r.id, "Overall verdict: PASS");
  let rec: Record<string, unknown>[] = [];
  for (let i = 0; i < 100 && rec.length === 0; i++) {
    await tick(100);
    rec = (await w.traceEvents()).filter((e) => e.event === "review_recorded");
  }
  assert.equal(rec.length, 1);
  return rec[0];
}

test("the real entry point takes the real launch snapshot: a same-content commit keeps the head via same_tree", async (t) => {
  const rec = await recorded(t, true);
  assert.equal(rec.via, "same_tree");
  assert.equal(typeof rec.head, "string");
  assert.equal(rec.why, undefined);
});

test("the shared rig's no-op snapshot fails closed: the same commit stays head_moved", async (t) => {
  const rec = await recorded(t, false);
  assert.equal(rec.head, null);
  assert.equal(rec.why, "head_moved");
  assert.equal(rec.via, undefined);
});

test("a missing or no-op snapshot dependency never accepts a moved head", async (t) => {
  const w = world(t);
  const g = repo(w.project);
  const start = await headsAt([w.project]);
  fs.writeFileSync(path.join(w.project, "a.txt"), "a2\n");
  g.git("commit", "-q", "-a", "-m", "work");
  const end = await headOf(w.project);
  const moved = { head: null, why: "head_moved" };
  assert.deepEqual(await treesAt([w.project]), new Map([[w.project, null]]));
  assert.deepEqual(await reviewedHeadVia(start, await treesAt([w.project]), w.project, end), moved, "no dependency");
  assert.deepEqual(await reviewedHeadVia(start, await treesAt([w.project], async () => null), w.project, end), moved, "no-op");
});
