// The PR's own signals decide "reviewed" (prready.ts reviewFactsForHead) and the sent-back heads (planstate.ts sentBackMark, sentBackUnmark, sentBackRestore) keep a
// send-back from being undone by a review of another head. Three parts: the helper's cases, the three pure functions, and the sequences in the in-process adapter
// world of rework-child.test.ts (a real git repository in the project so the reviews carry heads).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeRework } from "../session.ts";
import { buildCeremonyState, CEREMONY_ENTRY, latestCeremonyState, sentBackMark, sentBackRestore, sentBackUnmark } from "../planstate.ts";
import { readiness, reviewFactsForHead } from "../prready.ts";
import type { ReviewRecord } from "../reviews.ts";
import { tick, world } from "./_r46world.ts";

const H = "a".repeat(40);
const G = "b".repeat(40);
const rec = (o: Partial<ReviewRecord> = {}): ReviewRecord => ({ role: "reviewer", verdict: "pass", head: H, kind: "code", occasion: "pre-pr", ...o });
const ruleFor = (facts: ReturnType<typeof reviewFactsForHead>) => readiness({ facts, checks: "green", mergeable: true, mergeState: "clean", draft: false });

// --- the helper -----------------------------------------------------------------------------------------------------------------------------------------

test("helper: the [pre-pr] PASS on the head is reviewed; nothing in the session but that head's records counts", () => {
  assert.equal(reviewFactsForHead([rec()], H, []), "ok");
  assert.deepEqual(ruleFor(reviewFactsForHead([rec()], H, [])), { result: "ready", draft: false });
});

test("helper: a review of another PR or head after the PASS does not un-review it (a second PR reviewed in the same session)", () => {
  assert.equal(reviewFactsForHead([rec(), rec({ head: G })], H, []), "ok");
  assert.equal(reviewFactsForHead([rec(), rec({ head: G, verdict: "fail" })], H, []), "ok");
  assert.equal(reviewFactsForHead([rec({ head: G }), rec()], G, []), "ok", "and the other way round");
  assert.equal(reviewFactsForHead([rec(), rec({ head: null, verdict: "fail" })], H, []), "ok", "a record without a head is not this PR's");
});

test("helper: a new head without a [pre-pr] PASS is not reviewed; an empty head is not reviewed", () => {
  assert.equal(reviewFactsForHead([rec()], G, []), "unreviewed");
  assert.equal(reviewFactsForHead([rec()], "", []), "unreviewed");
  assert.deepEqual(ruleFor(reviewFactsForHead([rec()], G, [])), { result: "unreviewed", draft: true });
});

test("helper: an item PASS on the head is not enough, also after a [pre-pr] PASS", () => {
  assert.equal(reviewFactsForHead([rec({ occasion: "item" })], H, []), "unreviewed");
  assert.equal(reviewFactsForHead([rec(), rec({ occasion: "item" })], H, []), "unreviewed");
});

test("helper: a FAIL after the PASS on the same head is work in progress (back to draft)", () => {
  const facts = reviewFactsForHead([rec(), rec({ verdict: "fail" })], H, []);
  assert.equal(facts, "wip");
  assert.deepEqual(ruleFor(facts), { result: "wip", draft: true });
});

test("helper: a sent-back head is work in progress, a head that is not in the set is not", () => {
  assert.equal(reviewFactsForHead([rec()], H, [H]), "wip");
  assert.equal(reviewFactsForHead([rec()], H, [G]), "ok");
  assert.equal(reviewFactsForHead([rec(), rec({ head: G })], H, [H]), "wip", "a PASS on another head does not bring it back");
});

test("helper: a builder launch or project edit has no input; the plan's records never count", () => {
  assert.equal(reviewFactsForHead.length, 3, "records, head, sent-back heads only");
  assert.equal(reviewFactsForHead([rec(), rec({ kind: "plan", head: null, verdict: "fail", occasion: undefined })], H, []), "ok");
});

// --- the pure functions ---------------------------------------------------------------------------------------------------------------------------------

test("sentBackMark: every head whose newest verdict is a [pre-pr] PASS joins; others and plan records do not", () => {
  const reviews = [rec({ head: H }), rec({ head: G }), rec({ head: G, verdict: "fail" }), rec({ head: "c".repeat(40), occasion: "item" }), rec({ kind: "plan", head: null })];
  assert.deepEqual(sentBackMark([], reviews), [H]);
  assert.deepEqual(sentBackMark(["d".repeat(40)], reviews), ["d".repeat(40), H], "kept heads stay");
  assert.deepEqual(sentBackMark([H], reviews), [H], "no duplicates");
  assert.deepEqual(sentBackMark([], []), []);
});

test("sentBackUnmark: a [pre-pr] PASS takes its own head out and only that head; item, FAIL and headless records change nothing", () => {
  assert.deepEqual(sentBackUnmark([H, G], rec({ head: H })), [G]);
  assert.deepEqual(sentBackUnmark([H], rec({ head: G })), [H], "a PASS on another head does not");
  assert.deepEqual(sentBackUnmark([H], rec({ occasion: "item" })), [H]);
  assert.deepEqual(sentBackUnmark([H], rec({ verdict: "fail" })), [H]);
  assert.deepEqual(sentBackUnmark([H], rec({ head: null })), [H]);
});

test("sentBackRestore: a stored set comes back; the flag without a set converts from the reviews; no flag and no set is empty", () => {
  const reviews = [rec({ head: H }), rec({ head: G }), rec({ head: G, verdict: "fail" })];
  assert.deepEqual(sentBackRestore({ sentBack: true, sentBackHeads: [G], reviews }), [G]);
  assert.deepEqual(sentBackRestore({ sentBack: true, reviews }), [H]);
  assert.deepEqual(sentBackRestore({ reviews }), []);
  assert.deepEqual(sentBackRestore({ sentBackHeads: [], sentBack: true, reviews }), [], "a stored empty set stays empty");
});

test("the ceremony entry carries the set and reads it back; an entry without it parses", () => {
  const build = (heads: string[], sentBack: boolean) => buildCeremonyState({ plan: null, lineages: [], planPhase: false, reviews: [rec()], sentBack, sentBackHeads: heads });
  const entry = (data: unknown) => latestCeremonyState([{ type: "custom", customType: "pi-foreman-ceremony-state", data }]);
  assert.deepEqual(entry(build([H], true))?.sentBackHeads, [H]);
  assert.equal(build([], false).sentBackHeads, undefined);
  assert.equal(entry(build([], false))?.sentBackHeads, undefined);
  assert.equal(entry(build([], true))?.sentBack, true);
  assert.deepEqual(entry({ ...build([H], true), sentBackHeads: [H, 3, ""] })?.sentBackHeads, [H], "bad members are dropped");
});

// --- the adapter world ----------------------------------------------------------------------------------------------------------------------------------

type W = ReturnType<typeof world>;
type Rig = Awaited<ReturnType<W["adapter"]>>;
type State = { sentBack?: boolean; sentBackHeads?: string[]; reworkSeen?: number; reviews?: ReviewRecord[] };
const state = (w: W): State => (w.ceremonyEntries().at(-1)?.data ?? {}) as State;
const read = (a: Rig) => a.call("read", { path: "x.txt" });

function repo(dir: string): { git: (...a: string[]) => string; commit: (m: string) => string } {
  fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  return { git, commit: (m) => (git("commit", "-q", "--allow-empty", "-m", m), git("rev-parse", "HEAD")) };
}

let recorded = 0;
/** One `[pre-pr]` (or item) review run to its end; waits until it is recorded. */
async function review(a: Rig, verdict: "PASS" | "FAIL", task = "[pre-pr] review the branch"): Promise<void> {
  const r = await a.reviewLaunch(task);
  assert.ok(!r.blocked, r.blocked ?? "");
  a.endRun(r.id, `Overall verdict: ${verdict}`);
  recorded++;
  for (let i = 0; i < 100 && (await a.recordedReviews()) < recorded; i++) await tick(50);
  await tick(100);
}

/** A fresh world with a repository of `commits` empty commits (their heads, oldest first) and the review counter reset. */
function fresh(t: Parameters<typeof world>[0], commits = 1) {
  recorded = 0;
  const w = world(t, { handoff: true });
  const g = repo(w.project);
  const heads = Array.from({ length: commits }, (_, i) => g.commit(`chore: ${i + 1}`));
  return { w, g, heads };
}

/** Prepared review records, put in as a ceremony entry that the adapter's session start restores (data, not review runs). */
function seed(w: W, reviews: ReviewRecord[]): void {
  if (reviews.length > 0) w.entries.push({ type: "custom", customType: CEREMONY_ENTRY, data: buildCeremonyState({ plan: null, lineages: [], planPhase: false, reviews }) });
}

test("world: a send-back marks the head of the newest [pre-pr] PASS before anything else; the ceremony entry written at the marker's tool call holds it", async (t) => {
  const { w, heads: [h1] } = fresh(t);
  const a = await w.adapter("startup");
  await review(a, "PASS");
  assert.equal(state(w).sentBackHeads, undefined, "no send-back, no set");
  writeRework(w.handoff);
  await read(a);
  assert.deepEqual(state(w).sentBackHeads, [h1]);
  assert.equal(state(w).sentBack, true);
});

test("world: after a send-back a [pre-pr] PASS on another head leaves the sent-back head marked; the flag is cleared as before", async (t) => {
  const { w, g, heads: [h1] } = fresh(t);
  seed(w, [rec({ head: h1 })]);
  const a = await w.adapter("startup");
  writeRework(w.handoff);
  await read(a);
  const h2 = g.commit("chore: reworked");
  await review(a, "PASS");
  assert.equal(state(w).sentBack, undefined, "the existing flag clears on any [pre-pr] PASS");
  assert.deepEqual(state(w).sentBackHeads, [h1], "the sent-back head stays marked");
  assert.notEqual(h1, h2);
});

test("world: after a send-back a [pre-pr] PASS on the same head takes it out of the set", async (t) => {
  const { w, heads: [h1] } = fresh(t);
  seed(w, [rec({ head: h1 })]);
  const a = await w.adapter("startup");
  writeRework(w.handoff);
  await read(a);
  assert.deepEqual(state(w).sentBackHeads, [h1]);
  await review(a, "PASS");
  assert.equal(state(w).sentBackHeads, undefined, "the head left the set");
});

test("world: only the head of the new PASS leaves the set (two sent-back heads)", async (t) => {
  const { w, heads: [h1, h2] } = fresh(t, 2);
  seed(w, [rec({ head: h1 }), rec({ head: h2 })]);
  const a = await w.adapter("startup");
  writeRework(w.handoff);
  await read(a);
  assert.deepEqual([...(state(w).sentBackHeads ?? [])].sort(), [h1, h2].sort());
  await review(a, "PASS");
  assert.deepEqual(state(w).sentBackHeads, [h1], "h2 was reviewed again, h1 is still sent back");
});

test("world: an item PASS or a FAIL on the head does not take it out of the set", async (t) => {
  const { w, heads: [h1] } = fresh(t);
  seed(w, [rec({ head: h1 })]);
  const a = await w.adapter("startup");
  await a.writeLedger("# Ledger\n- [ ] 1. item\n- [ ] V. Verified by a reviewer\n");
  writeRework(w.handoff);
  await read(a);
  await review(a, "PASS", "review items 1 of the diff");
  await review(a, "FAIL");
  assert.deepEqual(state(w).sentBackHeads, [h1]);
});

test("world: the sent-back set survives a reload", async (t) => {
  const { w, heads: [h1] } = fresh(t);
  seed(w, [rec({ head: h1 })]);
  const a = await w.adapter("startup");
  writeRework(w.handoff);
  await read(a);
  await a.down();
  const again = await w.adapter("reload");
  await read(again);
  assert.deepEqual(state(w).sentBackHeads, [h1]);
  writeRework(w.handoff);
  await review(again, "PASS");
  assert.equal(state(w).sentBackHeads, undefined, "and the same head's PASS after the reload clears it");
});

test("world: an older stored entry with the flag and no set keeps the reviewed heads sent back", async (t) => {
  const { w, heads: [h1] } = fresh(t);
  seed(w, [rec({ head: h1 })]);
  const a = await w.adapter("startup");
  writeRework(w.handoff);
  await read(a);
  await a.down();
  const last = w.ceremonyEntries().at(-1)!;
  const { sentBackHeads: _drop, ...older } = last.data as Record<string, unknown>;
  assert.equal(older.sentBack, true);
  w.entries.push({ type: "custom", customType: "pi-foreman-ceremony-state", data: older });
  const again = await w.adapter("reload");
  await read(again);
  assert.deepEqual(state(w).sentBackHeads, [h1], "converted from the restored reviews, written back with the next entry");
});

test("world: more than 50 review records after a send-back neither bring the head back nor lock a re-reviewed head in draft", async (t) => {
  const { w, g, heads: [h1] } = fresh(t);
  seed(w, [rec({ head: h1 })]);
  const a = await w.adapter("startup");
  writeRework(w.handoff);
  await read(a);
  const h2 = g.commit("chore: more work");
  await a.down();
  // 52 later [pre-pr] PASS records on h2, appended after the sent-back head's own record: data, not 52 review runs
  const cur = state(w);
  w.entries.push({ type: "custom", customType: CEREMONY_ENTRY, data: { ...cur, reviews: [...(cur.reviews ?? []), ...Array.from({ length: 52 }, () => rec({ head: h2 }))] } });
  const again = await w.adapter("reload");
  await read(again);
  // a real [pre-pr] PASS on HEAD (h2) persists the restored state (an identical restore writes nothing): the list is trimmed to 50, h1's own
  // record is gone, and h1 stays sent back because the stored set brought it back, not because a record still names it
  await review(again, "PASS");
  assert.equal(state(w).reviews?.length, 50, "the list is trimmed");
  assert.ok(!state(w).reviews?.some((r) => r.head === h1), "the sent-back head's own record is gone");
  assert.deepEqual(state(w).sentBackHeads, [h1], "the head is still sent back");
  g.git("checkout", "-q", h1);
  await review(again, "PASS");
  assert.equal(state(w).sentBackHeads, undefined, "a re-review of the head takes it out");
});
