// The PR gate and the ledger's review gate take the same reviewer PASS: the verdicts and the heads they covered survive
// compaction and /reload (ceremony-state entry), a PASS for another commit stays stale_review, a PASS without a head
// is refused with a message that names why (not "no reviewer PASS is recorded").
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { reviewsOfEntry } from "../reviews.ts";
import { tick, world } from "./_r46world.ts";

type Rig = Awaited<ReturnType<ReturnType<typeof world>["adapter"]>>;

function repo(dir: string): { git: (...a: string[]) => string; commit: (m: string) => string } {
  fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  const commit = (m: string) => {
    git("commit", "-q", "--allow-empty", "-m", m);
    return git("rev-parse", "HEAD");
  };
  return { git, commit };
}

/** One `[pre-pr]` reviewer run, from launch to run end; `during` runs between the two. */
async function review(a: Rig, verdict: "PASS" | "FAIL", during?: () => void): Promise<string | null> {
  const r = await a.reviewLaunch("[pre-pr] review the branch");
  if (r.blocked) return r.blocked;
  during?.();
  a.endRun(r.id, `Overall verdict: ${verdict}`);
  await tick(100);
  return null;
}

const pr = (a: Rig) => a.checkCall("create_pull_request", {});
const refused = (b: { block?: boolean; reason?: string } | undefined, reason: string): boolean => b?.block === true && (b.reason ?? "").includes(`[pr_refused:${reason}]`);

for (const how of ["compaction", "reload"] as const) {
  test(`FAIL, FAIL, ${how}, PASS on H: pr_create on H is allowed; a later commit is stale_review`, async (t) => {
    const w = world(t);
    const g = repo(w.project);
    const h = g.commit("chore: a");
    let a = await w.adapter("startup");
    assert.equal(await review(a, "FAIL"), null);
    assert.equal(await review(a, "FAIL"), null);
    if (how === "compaction") await a.fire("session_compact", { reason: "manual", compactionEntry: { summary: "s" } });
    else {
      await a.down();
      a = await w.adapter("reload");
    }
    assert.equal(await review(a, "PASS"), null);
    assert.equal(await pr(a), undefined, "PASS on H opens the gate for H");
    if (how === "reload") {
      await a.down();
      a = await w.adapter("reload");
      assert.equal(await pr(a), undefined, "the reviewed head came back after a second reload");
    }
    g.commit("chore: b");
    assert.ok(refused(await pr(a), "stale_review"), `stale after a new commit (was ${h})`);
  });
}

test("a PASS with a commit made while the reviewer ran is refused with the reason, not as no_review", async (t) => {
  const w = world(t);
  const g = repo(w.project);
  g.commit("chore: a");
  const a = await w.adapter("startup");
  assert.equal(await review(a, "PASS", () => void g.commit("chore: during")), null);
  const b = await pr(a);
  assert.ok(refused(b, "no_review") || refused(b, "stale_review"));
  assert.match(b?.reason ?? "", /carries no commit/);
  assert.doesNotMatch(b?.reason ?? "", /no reviewer PASS is recorded/);
});

test("reviewsOfEntry drops malformed records and keeps head-null PASS records", () => {
  const sha = "a".repeat(40);
  const out = reviewsOfEntry([{ role: "reviewer", verdict: "pass", head: sha }, { role: "reviewer", verdict: "pass", head: null }, { role: "reviewer", verdict: "maybe", head: sha }, { role: "reviewer", verdict: "pass", head: "xyz" }, null, 3]);
  assert.deepEqual(out, [{ role: "reviewer", verdict: "pass", head: sha }, { role: "reviewer", verdict: "pass", head: null }]);
  assert.deepEqual(reviewsOfEntry("x"), []);
});
