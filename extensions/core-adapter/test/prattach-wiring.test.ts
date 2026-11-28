// Images in a pull request through the real adapter (prattach.ts, index.ts): the `attach` field of a reviewer launch (refusals, task block, route, record) and the
// persisted shapes (record, route) after a reload. World as in review-same-tree.test.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { buildCeremonyState, CEREMONY_ENTRY } from "../planstate.ts";
import { attachRefusal } from "../prattach.ts";
import { coverAliases } from "../reviewcover.ts";
import { reviewsOfEntry, type ReviewRecord } from "../reviews.ts";
import { tick, world } from "./_r46world.ts";

const chunk = (type: string, data: Buffer = Buffer.alloc(0)): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
};
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG = Buffer.concat([SIG, chunk("IHDR", Buffer.alloc(13)), chunk("IDAT", Buffer.from("x")), chunk("IEND")]);
const PNG2 = Buffer.concat([PNG, Buffer.from("z")]);
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const SHOT = ".workflow/screenshots/a.png";

function fresh(t: Parameters<typeof world>[0]) {
  const w = world(t, { realSnapshot: true });
  fs.rmSync(path.join(w.project, ".git"), { recursive: true, force: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", w.project, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(w.project, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "base");
  const shot = path.join(w.project, SHOT);
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  fs.writeFileSync(shot, PNG);
  return { w, shot, top: fs.realpathSync.native(w.project) };
}

const reviews = (w: ReturnType<typeof world>) => ((w.ceremonyEntries().at(-1)?.data ?? {}) as { reviews?: ReviewRecord[] }).reviews ?? [];
const routes = (w: ReturnType<typeof world>) => w.entries.filter((e) => e.customType === "pi-foreman-ledger-route").map((e) => e.data as { review?: { attach?: { path: string; sha256: string }[] } });
async function recorded(w: ReturnType<typeof world>, n: number): Promise<void> {
  for (let i = 0; i < 200 && reviews(w).length < n; i++) await tick(50);
  await tick(100);
}

test("launch: attach without a pre-pr occasion is refused; the [pre-pr] tag and the occasion field accept it", async (t) => {
  const { w } = fresh(t);
  const a = await w.adapter("startup");
  const plain = await a.reviewLaunch("[plan-review] review the plan", { attach: [SHOT] });
  assert.match(plain.blocked ?? "", /attach_needs_pre_pr/);
  const tagged = await a.reviewLaunch("[pre-pr] review the branch", { attach: [SHOT] });
  assert.equal(tagged.blocked, null);
  const field = await a.reviewLaunch("review the branch", { attach: [SHOT], occasion: "pre-pr" });
  assert.equal(field.blocked, null, field.blocked ?? "");
});

test("launch: the task carries the absolute paths and the look-at-each instruction; bad lists are refused", async (t) => {
  const { w, top } = fresh(t);
  const a = await w.adapter("startup");
  const r = await a.reviewLaunch("[pre-pr] review the branch", { attach: [SHOT] });
  assert.equal(r.blocked, null);
  assert.ok(r.task.includes(path.join(top, SHOT)), r.task);
  assert.match(r.task, /private data/);
  assert.match((await a.reviewLaunch("[pre-pr] x", { attach: ["../out.png"] })).blocked ?? "", /attach_outside|attach_missing/);
  assert.match((await a.reviewLaunch("[pre-pr] x", { attach: ["clip.gif"] })).blocked ?? "", /attach_/);
});

test("verdict: an unchanged image is recorded with its sha256 on a PASS; the route in the session file keeps the list", async (t) => {
  const { w } = fresh(t);
  const a = await w.adapter("startup");
  const r = await a.reviewLaunch("[pre-pr] review the branch", { attach: [SHOT] });
  assert.equal(r.blocked, null);
  assert.deepEqual(routes(w).at(-1)?.review?.attach, [{ path: SHOT, sha256: sha(PNG) }]);
  a.endRun(r.id, "Overall verdict: PASS");
  await recorded(w, 1);
  assert.deepEqual(reviews(w)[0].attach, [{ path: SHOT, sha256: sha(PNG) }]);
});

test("verdict: an image changed between launch and verdict is left out of the record; a FAIL records none", async (t) => {
  const { w, shot } = fresh(t);
  const a = await w.adapter("startup");
  const r = await a.reviewLaunch("[pre-pr] review the branch", { attach: [SHOT] });
  fs.writeFileSync(shot, PNG2);
  a.endRun(r.id, "Overall verdict: PASS");
  await recorded(w, 1);
  assert.equal(reviews(w)[0].verdict, "pass");
  assert.equal(reviews(w)[0].attach, undefined);
  fs.writeFileSync(shot, PNG);
  const f = await a.reviewLaunch("[pre-pr] review the branch", { attach: [SHOT] });
  a.endRun(f.id, "Overall verdict: FAIL");
  await recorded(w, 2);
  assert.equal(reviews(w)[1].verdict, "fail");
  assert.equal(reviews(w)[1].attach, undefined);
});

test("reload: the restored route of the launch keeps its attach list (a run that fails after the reload persists the route again, with the list)", async (t) => {
  const { w } = fresh(t);
  const a = await w.adapter("startup");
  const r = await a.reviewLaunch("[pre-pr] review the branch", { attach: [SHOT] });
  assert.equal(r.blocked, null);
  const before = routes(w).length;
  const again = await w.adapter("reload");
  again.endEvent({ runId: `run-${r.id}`, agent: "reviewer", success: false, status: "failed", results: [{ agent: "reviewer", status: "failed", success: false, output: "" }] });
  for (let i = 0; i < 100 && routes(w).length === before; i++) await tick(50);
  const last = routes(w).at(-1) as { review?: { attach?: unknown; failed?: boolean } };
  assert.equal(routes(w).length > before, true, "the restored route was persisted again");
  assert.equal(last.review?.failed, true);
  assert.deepEqual(last.review?.attach, [{ path: SHOT, sha256: sha(PNG) }]);
});

test("persist and restore: a record with attach survives buildCeremonyState and reviewsOfEntry; a bad list is dropped", () => {
  const rec: ReviewRecord = { role: "reviewer", verdict: "pass", head: "a".repeat(40), cwd: "/r", kind: "code", occasion: "pre-pr", attach: [{ path: SHOT, sha256: sha(PNG) }] };
  const stored = JSON.parse(JSON.stringify(buildCeremonyState({ plan: null, lineages: [], planPhase: false, reviews: [rec] }))) as { reviews: unknown[] };
  assert.deepEqual(stored.reviews[0] && (stored.reviews[0] as ReviewRecord).attach, rec.attach);
  assert.deepEqual(reviewsOfEntry(stored.reviews)[0].attach, rec.attach);
  const bad = [{ ...(stored.reviews[0] as object), attach: [{ path: SHOT, sha256: "nothex" }] }];
  assert.equal(reviewsOfEntry(bad)[0].attach, undefined);
});

test("session file: the ceremony entry restored by a reload keeps the attach of a record", async (t) => {
  const { w, top } = fresh(t);
  const head = execFileSync("git", ["-C", w.project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const rec: ReviewRecord = { role: "reviewer", verdict: "pass", head, cwd: top, kind: "code", occasion: "pre-pr", attach: [{ path: SHOT, sha256: sha(PNG) }] };
  w.entries.push({ type: "custom", customType: CEREMONY_ENTRY, data: buildCeremonyState({ plan: null, lineages: [], planPhase: false, reviews: [rec] }) });
  const a = await w.adapter("reload");
  await a.down();
  assert.deepEqual(reviews(w).at(-1)?.attach, rec.attach);
});

test("same-tree alias: the alias PASS carries attach and the attach gate accepts it", async () => {
  const head = "b".repeat(40);
  const alias = "c".repeat(40);
  const rec: ReviewRecord = { role: "reviewer", verdict: "pass", head, cwd: "/r", kind: "code", occasion: "pre-pr", tree: "t1", attach: [{ path: SHOT, sha256: sha(PNG) }] };
  const out = await coverAliases([rec], alias, { blocked: () => false, treeOf: async () => "t1" });
  assert.equal(out.length, 1);
  assert.equal(out[0].rec.via, "same_tree");
  assert.deepEqual(out[0].rec.attach, rec.attach);
  assert.equal(attachRefusal("pr_create", [out[0].rec], "/r", alias, rec.attach!), null);
});
