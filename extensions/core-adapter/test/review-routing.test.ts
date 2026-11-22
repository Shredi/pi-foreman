// Review routing (items 1 and 3 of the review-routing round): a review gets only the facts of its own checkout. Two worktrees of one session: the re-review
// line and the earlier findings, the failed items and the item defaults come from the last review of the same checkout, never from a sibling's; a `[pre-pr]`
// may name closed items. Rig: _hsrig.ts (real git worktrees).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { CEREMONY_ENTRY } from "../planstate.ts";
import { type Rig, commitIn, endRecord, git, launch, setup, tick, worktree } from "./_hsrig.ts";
import { readItemsSidecar } from "../verdict.ts";
import { bindingOf, type RecSpec } from "./_verdict-rig.ts";

const LEDGER = `# Ledger: x\nTier: standard\n\n${[1, 2, 3, 4, 5, 6, 7].map((n) => `- [ ] ${n}. item ${n}`).join("\n")}\n- [ ] V. fresh-eyes verification passed\n`;
const ITEMS_LINE = /\[pi-foreman verdict items\] review_verdict takes results for these items only: ([^.]*)\./;
const REREVIEW = "[pi-foreman re-review] Review the revision diff since";
const EARLIER = "[pi-foreman earlier findings]";

const failSpec = (item: number, text: string): RecSpec => ({ verdict: "fail", items: [{ id: item, result: "fail", note: text }], findings: [{ kind: "defect", text, file: "src/x.ts", line: 1 }] });
const passSpec = (...ids: number[]): RecSpec => ({ verdict: "pass", items: ids.map((id) => ({ id, result: "pass" as const })) });

/** The ids the items line of a launched task names. */
const idsOf = (task: unknown): string[] => (ITEMS_LINE.exec(String(task))?.[1] ?? "").split(", ").filter(Boolean);

/** Two worktrees with a builder run each; the ledger holds items 1-7 and V, all open. */
async function two(t: Parameters<typeof setup>[0], o: Parameters<typeof setup>[1] = {}) {
  const s = await setup(t, o);
  s.w.state.answer = "allow once";
  await s.a.writeLedger(LEDGER);
  const dirs = { A: worktree(s.w, "wta"), B: worktree(s.w, "wtb") };
  commitIn(dirs.A, "src/a.ts");
  commitIn(dirs.B, "src/b.ts");
  for (const dir of [dirs.A, dirs.B]) await rebuild(s.a, dir);
  return { ...s, ...dirs };
}

/** A builder run in `dir` that ends: the checkout is revised, so a review there is no duplicate of an earlier PASS. */
async function rebuild(a: Rig, dir: string) {
  const b = await launch(a, "builder", "build the widget", { cwd: dir });
  assert.equal(b.blocked, null, String(b.blocked));
  await tick(20);
  a.endRunAs(b.id, "builder", "done", dir);
  await tick(20);
}

/** An item review in `cwd` ending with `spec`; its launch input is returned for the task and binding. */
async function review(a: Rig, cwd: string, spec: RecSpec, task = "review items of the widget", extra: Record<string, unknown> = {}) {
  const r = await launch(a, "reviewer", task, { cwd, ...extra });
  assert.equal(r.blocked, null, String(r.blocked));
  await endRecord(a, r, "reviewer", spec, cwd);
  return r;
}
/** A review launch that is only started (its task is read), then ended without a verdict. */
async function started(a: Rig, cwd: string, task = "review items of the widget", extra: Record<string, unknown> = {}) {
  const r = await launch(a, "reviewer", task, { cwd, ...extra });
  assert.equal(r.blocked, null, String(r.blocked));
  return r;
}

test("T1: a FAIL in A gives no re-review line and no findings to a reviewer in B; a reviewer in A gets A's head and findings", async (t) => {
  const { a, A, B } = await two(t);
  await review(a, A, failSpec(1, "alpha defect"));
  const inB = await started(a, B);
  assert.doesNotMatch(String(inB.input.task), /re-review\]/, "no re-review line in B");
  assert.doesNotMatch(String(inB.input.task), /earlier findings|alpha defect|re-review items/);
  const inA = await started(a, A);
  const task = String(inA.input.task);
  assert.ok(task.startsWith(`${REREVIEW} ${git(A, "rev-parse", "HEAD")} `), task);
  assert.ok(task.includes(EARLIER) && task.includes("alpha defect"), task);
});

test("T2: FAIL in A then FAIL in B: the re-review in A names A's head and A's findings, not B's", async (t) => {
  const { a, A, B } = await two(t);
  await review(a, A, failSpec(1, "alpha defect"));
  await review(a, B, failSpec(2, "beta defect"));
  const inA = String((await started(a, A)).input.task);
  assert.ok(inA.startsWith(`${REREVIEW} ${git(A, "rev-parse", "HEAD")} `), inA);
  assert.match(inA, /alpha defect/);
  assert.doesNotMatch(inA, /beta defect/);
  const inB = String((await started(a, B)).input.task);
  assert.ok(inB.startsWith(`${REREVIEW} ${git(B, "rev-parse", "HEAD")} `), inB);
  assert.match(inB, /beta defect/);
  assert.doesNotMatch(inB, /alpha defect/);
});

test("T2b: a reload keeps A's head, findings and failed items; an older state with only lastFailFindings loads them into the session's checkout", async (t) => {
  const { a, w, A, B } = await two(t);
  await review(a, A, failSpec(2, "alpha defect"));
  await review(a, B, failSpec(3, "beta defect"));
  await tick(300);
  await a.down();
  const again = await w.adapter("reload");
  const inA = await started(again, A);
  const task = String(inA.input.task);
  assert.ok(task.startsWith(`${REREVIEW} ${git(A, "rev-parse", "HEAD")} `), task);
  assert.match(task, /alpha defect/);
  assert.doesNotMatch(task, /beta defect/);
  assert.match(task, /\[re-review items: 2\]/, "A's failed items, not B's");

  // an entry of the older shape: `lastFailFindings` and no per-checkout store
  const last = w.ceremonyEntries().at(-1)!.data as Record<string, unknown>;
  const old: Record<string, unknown> = { ...last, lastFailFindings: "- legacy finding" };
  delete old.reviewMemory;
  w.entries.push({ type: "custom", customType: CEREMONY_ENTRY, data: old });
  await again.down();
  const loaded = await w.adapter("reload");
  await started(loaded, A); // a launch settles the restore; its persisted state carries the facts
  await tick(300);
  const mem = (w.ceremonyEntries().at(-1)!.data as { reviewMemory?: Record<string, { findings: string | null }> }).reviewMemory ?? {};
  const own = fs.realpathSync.native(w.project);
  assert.equal(mem[own]?.findings, "- legacy finding", JSON.stringify(mem));
});

test("T2c: a resume of a review run in A after a FAIL in B takes A's failed items", async (t) => {
  const { a, A, B } = await two(t);
  await review(a, A, failSpec(2, "alpha defect"));
  const first = await started(a, A);
  await tick(50);
  a.endRunAs(first.id, "reviewer", "stopped before a verdict", A);
  await tick(100);
  await review(a, B, failSpec(3, "beta defect"));
  const id = `r${Math.random().toString(36).slice(2, 8)}`;
  const input: Record<string, unknown> = { action: "resume", id: `run-${first.id}`, message: "go on" };
  await a.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } });
  const res = (await a.fire("tool_call", { toolName: "subagent", toolCallId: id, input })) as { block?: boolean; reason?: string } | undefined;
  assert.equal(res?.block, undefined, res?.reason);
  assert.deepEqual(readItemsSidecar(bindingOf(first.input)!.verdictDir!), [2], "the failed item of A, not of B");
});

test("T2d: an item review in A without items leaves out the items B's reviews judged; the re-review line and the whole-change sentence use A's failed items; a fork starts empty", async (t) => {
  const { a, w, A, B } = await two(t);
  await review(a, B, passSpec(4, 5, 6, 7));
  await rebuild(a, A);
  const inA = await started(a, A);
  assert.deepEqual(idsOf(inA.input.task), ["1", "2", "3"], "items B judged are left out");
  await endRecord(a, inA, "reviewer", failSpec(2, "alpha defect"), A);
  const again = await started(a, A, "review items of the widget", { items: [1, 2, 3] });
  const task = String(again.input.task);
  assert.match(task, /\[re-review items: 2\]/);
  assert.match(task, /Items 1, 3: review them against the whole change/);
  await rebuild(a, B);
  const inB = String((await started(a, B)).input.task);
  assert.doesNotMatch(inB, /re-review/, "B never failed");
  await a.writeLedger(LEDGER); // every item open again: the store of the parent would still leave out 4-7
  await tick(300);
  await a.down();
  const fork = await w.adapter("fork");
  const forked = String((await started(fork, A)).input.task);
  assert.doesNotMatch(forked, /re-review\]|earlier findings/);
  assert.deepEqual(idsOf(forked), ["1", "2", "3", "4", "5", "6", "7"], "a fork starts with an empty store");
});

test("T4: item reviews in A judge 1-3 and leave 4-7 open, B judges 4-7: a [pre-pr] in A without items takes 1-3", async (t) => {
  const { a, w, A, B } = await two(t);
  await review(a, A, passSpec(1, 2, 3));
  await review(a, B, passSpec(4, 5, 6, 7));
  await tick(300);
  const pre = await started(a, A, "[pre-pr] review the branch");
  assert.deepEqual(idsOf(pre.input.task), ["1", "2", "3"]);
  assert.deepEqual(bindingOf(pre.input)?.items, [1, 2, 3]);
  const ledger = fs.readFileSync(path.join(w.project, ".workflow", "LEDGER-x.md"), "utf8");
  for (const n of [4, 5, 6, 7]) assert.match(ledger, new RegExp(`- \\[[ x]\\] ${n}\\. `));
  // B's [pre-pr] takes its own
  const preB = await started(a, B, "[pre-pr] review the branch");
  assert.deepEqual(idsOf(preB.input.task), ["4", "5", "6", "7"]);
});

test("T5: a [pre-pr] naming closed items is accepted and lists them; the same items on an item review are refused", async (t) => {
  const { a, w, A } = await two(t);
  await a.writeLedger(`${LEDGER}- [x] 8. done eight\n- [x] 9. done nine\n`);
  const refused = await launch(a, "reviewer", "review items of the widget", { cwd: A, items: [8, 9] });
  assert.match(refused.blocked ?? "", /items 8, 9 are not open on the ledger/);
  assert.match(refused.blocked ?? "", /\[pre-pr\]/, "the refusal names the pre-pr exception");
  const pre = await launch(a, "reviewer", "[pre-pr] review the branch", { cwd: A, items: [8, 9] });
  assert.equal(pre.blocked, null, String(pre.blocked));
  assert.deepEqual(idsOf(pre.input.task), ["8", "9"]);
  assert.deepEqual(bindingOf(pre.input)?.items, [8, 9]);
  await endRecord(a, pre, "reviewer", passSpec(8, 9), A);
  await tick(300);
  const ledger = fs.readFileSync(path.join(w.project, ".workflow", "LEDGER-x.md"), "utf8");
  assert.match(ledger, /- \[x\] 8\. /);
  assert.match(ledger, /- \[x\] 9\. /);
  assert.equal((ledger.match(/- \[ \]/g) ?? []).length, 8, "the open items are unchanged: 1-7 and V");
});
