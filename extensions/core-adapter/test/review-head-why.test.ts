// A review without a head names why (reviews.ts reviewedHeadWhy), the trace says so per record (review_recorded),
// and closing V on such a PASS carries the notice that the PR gate will refuse.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { headOf, headsAt, reviewedHeadWhy } from "../reviews.ts";
import { rmTestTmp } from "./_tmpbase.ts";
import { tick, world } from "./_r46world.ts";

function repo(dir: string): { commit: (m: string) => string } {
  fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  return {
    commit: (m: string) => {
      git("commit", "-q", "--allow-empty", "-m", m);
      return git("rev-parse", "HEAD");
    },
  };
}

test("reviewedHeadWhy: every null head has its reason, a matching head none", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-why-")));
  try {
    const g = repo(dir);
    const h = g.commit("chore: a");
    const start = await headsAt([dir]);
    assert.deepEqual(reviewedHeadWhy(start, dir, h), { head: h });
    assert.equal(reviewedHeadWhy(undefined, dir, h).why, "no_launch_head");
    assert.equal(reviewedHeadWhy(new Map([[dir, null]]), dir, h).why, "no_launch_head");
    assert.equal(reviewedHeadWhy(start, dir, null).why, "head_unread");
    assert.equal(reviewedHeadWhy(new Map([[dir, h], [path.join(dir, "x"), h]]), path.join(dir, "elsewhere"), h).why, "cwd_unmatched");
    g.commit("chore: b");
    assert.equal(reviewedHeadWhy(start, dir, await headOf(dir)).why, "head_moved");
  } finally {
    rmTestTmp(dir);
  }
});

test("reviewedHeadWhy: a symlinked checkout matches the start map key of the real path, and the reverse", async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-why-")));
  try {
    const g = repo(dir);
    const h = g.commit("chore: a");
    const link = `${dir}-link`;
    try {
      fs.symlinkSync(dir, link, "dir");
    } catch {
      t.skip("no symlinks here");
      return;
    }
    try {
      const other = new Map<string, string | null>([[path.join(dir, "sub"), h], [dir, h]]);
      assert.deepEqual(reviewedHeadWhy(other, link, h), { head: h }, "run cwd by the link, key by the real path");
      const byLink = new Map<string, string | null>([[link, h], [path.join(dir, "sub"), h]]);
      assert.deepEqual(reviewedHeadWhy(byLink, dir, h), { head: h }, "run cwd by the real path, key by the link");
    } finally {
      fs.rmSync(link, { force: true });
    }
  } finally {
    rmTestTmp(dir);
  }
});

test("a PASS whose commit moved: review_recorded names head null and why; V closes with the notice", async (t) => {
  const w = world(t);
  const g = repo(w.project);
  g.commit("chore: a");
  const a = await w.adapter("startup");
  await a.writeLedger("# Ledger\n- [ ] 1. item\n- [ ] V. Verified by a reviewer\n");
  const r = await a.reviewLaunch("[pre-pr] review the branch");
  assert.ok(!r.blocked, r.blocked);
  g.commit("chore: during");
  a.endRun(r.id, "Overall verdict: PASS");
  await tick(100);
  const rec = (await w.traceEvents()).filter((e) => e.event === "review_recorded");
  assert.equal(rec.length, 1);
  assert.equal(rec[0].verdict, "pass");
  assert.equal(rec[0].head, null);
  assert.equal(rec[0].why, "head_moved");
  assert.equal(rec[0].role, "reviewer");
  assert.equal(typeof rec[0].runId, "string");
  const out = (await a.tool("foreman_ledger")!.execute("lv", { action: "mark", items: ["V"] }, undefined, undefined, a.ctx)) as { content: { text: string }[] };
  const text = out.content.map((c) => c.text).join("\n");
  assert.match(text, /carries no commit \(head_moved\)/);
  assert.match(text, /PR gate will refuse/);
});
