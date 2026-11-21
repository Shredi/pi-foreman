// D117: a reviewer PASS stays valid for a commit whose tree equals the reviewed content (reviews.ts `tree`/`via`, reviewcover.ts, index.ts coverHead).
// In-process adapter world over a real git repository with the real launch snapshot; the PR gate for other packages' PR tools (`create_pull_request`)
// is the probe, the git pack's pr_create and the PR watch get their own cases.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { commitTreeNoWorkflow } from "../commentonly.ts";
import { registerPrPack } from "../gitpack.ts";
import type { PrPackSession } from "../gitpack.ts";
import { buildCeremonyState, CEREMONY_ENTRY } from "../planstate.ts";
import { PrWatches } from "../prwatch.ts";
import type { StoreRead, Timers, WatchSnapshot } from "../prwatch.ts";
import { reviewFactsForHead } from "../prready.ts";
import { coverAliases } from "../reviewcover.ts";
import { passHeads, reviewsOfEntry, type ReviewRecord } from "../reviews.ts";
import type { Spawner } from "../spawn.ts";
import { tick, world } from "./_r46world.ts";

type W = ReturnType<typeof world>;
type Rig = Awaited<ReturnType<W["adapter"]>>;

function repo(dir: string): { git: (...a: string[]) => string; commit: (m: string, ...paths: string[]) => string } {
  fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...a], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "base");
  return { git, commit: (m, ...paths) => (git("add", ...(paths.length > 0 ? paths : ["-A"])), git("commit", "-q", "--allow-empty", "-m", m), git("rev-parse", "HEAD")) };
}

const state = (w: W) => (w.ceremonyEntries().at(-1)?.data ?? {}) as { reviews?: ReviewRecord[]; sentBackHeads?: string[] };
const gate = async (a: Rig, input: Record<string, unknown> = {}): Promise<string> => (await a.checkCall("create_pull_request", input))?.reason ?? "";

let recorded = 0;
/** One review run (launched now, `during` runs while it is open) to its recorded end. */
async function review(a: Rig, verdict: "PASS" | "FAIL", during?: () => void): Promise<void> {
  const r = await a.reviewLaunch("[pre-pr] review the branch");
  assert.ok(!r.blocked, r.blocked ?? "");
  during?.();
  a.endRun(r.id, `Overall verdict: ${verdict}`);
  recorded++;
  for (let i = 0; i < 200 && (await a.recordedReviews()) < recorded; i++) await tick(50);
  await tick(100);
}

function fresh(t: Parameters<typeof world>[0]) {
  recorded = 0;
  const w = world(t, { realSnapshot: true });
  const g = repo(w.project);
  return { w, g, file: (name: string, text: string) => fs.writeFileSync(path.join(w.project, name), text) };
}

test("a PASS on a dirty tree stays valid for a commit of exactly that tree: the gate for other packages' PR tools passes, and the alias is recorded", async (t) => {
  const { w, g, file } = fresh(t);
  const a = await w.adapter("startup");
  file("a.txt", "a2\n");
  await review(a, "PASS");
  assert.equal(typeof state(w).reviews?.[0].tree, "string", "the record carries the reviewed tree");
  assert.equal(await gate(a), "", "HEAD is still the reviewed head");
  const head = g.commit("work", "a.txt");
  assert.equal(await gate(a), "", "the same content, committed");
  const recs = state(w).reviews ?? [];
  const alias = recs.find((r) => r.head === head);
  assert.equal(alias?.via, "same_tree");
  assert.equal(alias?.verdict, "pass");
  assert.equal(alias?.occasion, "pre-pr");
  assert.ok(passHeads(recs).includes(head));
});

test("a commit of only part of the reviewed files is refused stale_review; a second commit that completes the content is accepted", async (t) => {
  const { w, g, file } = fresh(t);
  const a = await w.adapter("startup");
  file("a.txt", "a2\n");
  file("b.txt", "b\n");
  await review(a, "PASS");
  g.commit("part", "a.txt");
  assert.match(await gate(a), /\[pr_refused:stale_review\]/, "only part of the reviewed files");
  g.commit("rest", "b.txt");
  assert.equal(await gate(a), "", "the tip holds exactly the reviewed content: two commits are no problem");
});

test("the reviewed content plus one more change is refused", async (t) => {
  const { w, g, file } = fresh(t);
  const a = await w.adapter("startup");
  file("a.txt", "a2\n");
  await review(a, "PASS");
  file("c.txt", "c\n");
  g.commit("work+", "a.txt", "c.txt");
  assert.match(await gate(a), /\[pr_refused:stale_review\]/);
  assert.equal((state(w).reviews ?? []).filter((r) => r.via).length, 0);
});

test("a file that changed while the reviewer ran gives the record no tree, and the commit is refused", async (t) => {
  const { w, g, file } = fresh(t);
  const a = await w.adapter("startup");
  file("a.txt", "a2\n");
  await review(a, "PASS", () => file("a.txt", "a3\n"));
  assert.equal(state(w).reviews?.[0].tree, undefined);
  g.commit("work", "a.txt");
  assert.match(await gate(a), /\[pr_refused:stale_review\]/);
});

test("a FAIL after the PASS on the same content blocks the same-tree commit", async (t) => {
  const { w, g, file } = fresh(t);
  const a = await w.adapter("startup");
  file("a.txt", "a2\n");
  await review(a, "PASS");
  await review(a, "FAIL");
  g.commit("work", "a.txt");
  assert.match(await gate(a), /\[pr_refused:/);
  assert.equal((state(w).reviews ?? []).filter((r) => r.via).length, 0);
});

test("a FAIL already recorded at that head gets no alias", async (t) => {
  const { w, g, file } = fresh(t);
  const a = await w.adapter("startup");
  file("a.txt", "a2\n");
  await review(a, "PASS");
  const head = g.commit("work", "a.txt");
  await review(a, "FAIL"); // a review of the committed content: a record at `head`
  assert.equal((state(w).reviews ?? []).some((r) => r.head === head && r.verdict === "fail"), true);
  assert.match(await gate(a), /\[pr_refused:/);
  assert.equal((state(w).reviews ?? []).filter((r) => r.via).length, 0);
});

test("changes under .workflow/ are ignored on both sides", async (t) => {
  const { w, g, file } = fresh(t);
  const a = await w.adapter("startup");
  file("a.txt", "a2\n");
  await review(a, "PASS");
  fs.writeFileSync(path.join(w.project, ".workflow", "note.md"), "later\n"); // after the review, committed with the work
  const head = g.commit("work incl notes", "-A");
  assert.ok(g.git("ls-tree", "-r", "--name-only", head).includes(".workflow/note.md"));
  assert.equal(await gate(a), "");
});

test("an alias keeps its via after a reload and the gate still passes; a review round after it works", async (t) => {
  const { w, g, file } = fresh(t);
  const a = await w.adapter("startup");
  file("a.txt", "a2\n");
  await review(a, "PASS");
  const head = g.commit("work", "a.txt");
  assert.equal(await gate(a), "");
  for (let i = 0; i < 100 && state(w).reviews?.find((r) => r.head === head)?.via !== "same_tree"; i++) await new Promise((r) => setTimeout(r, 50));
  await a.down();
  const again = await w.adapter("reload");
  assert.equal(state(w).reviews?.find((r) => r.head === head)?.via, "same_tree");
  assert.equal(await gate(again), "");
  recorded = 0;
  await review(again, "FAIL");
  for (let i = 0; i < 100 && state(w).reviews?.at(-1)?.verdict !== "fail"; i++) await tick(50); // the FAIL record itself, not the count (0 after the reload)
  assert.equal(state(w).reviews?.at(-1)?.verdict, "fail");
});

test("a record without a tree keeps the head rule; pr_create with a branch argument covers that branch's commit", async (t) => {
  const { w, g } = fresh(t);
  const h1 = g.git("rev-parse", "HEAD");
  const top = fs.realpathSync.native(w.project);
  const tree = (await commitTreeNoWorkflow(top, h1))!;
  const seeded = (withTree: boolean) => {
    w.entries.splice(0);
    w.entries.push({ type: "custom", customType: CEREMONY_ENTRY, data: buildCeremonyState({ plan: null, lineages: [], planPhase: false, reviews: [{ role: "reviewer", verdict: "pass", head: h1, cwd: top, kind: "code", occasion: "pre-pr", ...(withTree ? { tree } : {}) }] }) });
  };
  seeded(false);
  g.git("commit", "-q", "--allow-empty", "-m", "same tree");
  const a = await w.adapter("startup");
  assert.match(await gate(a), /\[pr_refused:stale_review\]/, "an old record has no tree");
  await a.down();
  seeded(true);
  const b = await w.adapter("startup");
  g.git("branch", "feature");
  g.git("reset", "-q", "--hard", h1); // the session's HEAD is the reviewed head, `feature` is the same-tree commit
  assert.equal(await gate(b, { head: "feature" }), "", "the branch argument names the same-tree commit");
});

test("a same-tree commit after a send-back stays in the sent-back heads until a new [pre-pr] PASS", async (t) => {
  const { w, g } = fresh(t);
  const h1 = g.git("rev-parse", "HEAD");
  const top = fs.realpathSync.native(w.project);
  const tree = (await commitTreeNoWorkflow(top, h1))!;
  const rec: ReviewRecord = { role: "reviewer", verdict: "pass", head: h1, cwd: top, kind: "code", occasion: "pre-pr", tree };
  w.entries.push({ type: "custom", customType: CEREMONY_ENTRY, data: buildCeremonyState({ plan: null, lineages: [], planPhase: false, reviews: [rec], sentBack: true, sentBackHeads: [h1] }) });
  const a = await w.adapter("startup");
  const h2 = g.commit("same tree");
  await gate(a);
  const st = state(w);
  assert.deepEqual([...(st.sentBackHeads ?? [])].sort(), [h1, h2].sort());
  assert.equal(reviewFactsForHead(st.reviews ?? [], h2, st.sentBackHeads ?? []), "wip");
});

test("no alias while an uncleared high-stakes FAIL stands in that checkout", async (t) => {
  const { w, g } = fresh(t);
  const h1 = g.git("rev-parse", "HEAD");
  const top = fs.realpathSync.native(w.project);
  const tree = (await commitTreeNoWorkflow(top, h1))!;
  const rec: ReviewRecord = { role: "reviewer", verdict: "pass", head: h1, cwd: top, kind: "code", occasion: "pre-pr", tree };
  const hs = (failed: boolean) => ({ fired: { reasons: ["design"] }, runIds: [], runs: failed ? [{ verdict: "fail" as const, head: h1, cwd: top, revised: false, handed: false, cleared: false }] : [], bases: {} });
  for (const failed of [true, false]) {
    w.entries.splice(0);
    w.entries.push({ type: "custom", customType: CEREMONY_ENTRY, data: buildCeremonyState({ plan: null, lineages: [], planPhase: false, reviews: [rec], highStakes: hs(failed) }) });
    const a = await w.adapter("startup");
    g.git("commit", "-q", "--allow-empty", "-m", `same tree ${failed}`);
    await gate(a);
    assert.equal((state(w).reviews ?? []).some((r) => r.via === "same_tree"), !failed, failed ? "no alias" : "the alias");
    await a.down();
  }
});

test("coverAliases: only the checkout whose newest code review is a PASS with a tree earns the alias; the old record and the plan record earn none", async () => {
  const H = "a".repeat(40);
  const X = "b".repeat(40);
  const pass = (o: Partial<ReviewRecord> = {}): ReviewRecord => ({ role: "reviewer", verdict: "pass", head: H, cwd: "/co", kind: "code", tree: "e".repeat(40), ...o });
  const treeOf = async () => "e".repeat(40);
  const run = (records: ReviewRecord[], first?: string) => coverAliases(records, X, { first, blocked: () => false, treeOf });
  assert.equal((await run([pass()])).length, 1);
  assert.equal((await run([pass({ tree: undefined })])).length, 0, "old record");
  assert.equal((await run([pass({ kind: "plan" })])).length, 0, "plan record");
  assert.equal((await run([pass(), pass({ verdict: "fail", tree: undefined })])).length, 0, "a later FAIL without a tree");
  assert.equal((await run([pass(), pass({ head: X, verdict: "fail" })])).length, 0, "a record at the head");
  assert.equal((await run([pass(), pass({ via: "same_tree", head: "c".repeat(40) })])).length, 1, "aliases do not count as the newest review");
  assert.equal((await coverAliases([pass()], X, { blocked: () => true, treeOf })).length, 0, "blocked checkout");
  assert.equal((await coverAliases([pass()], X, { blocked: () => false, treeOf: async () => null })).length, 0, "commit does not resolve");
  assert.deepEqual((await run([pass(), pass({ cwd: "/other" })], "/other")).map((x) => x.rec.cwd), ["/other", "/co"], "the given checkout is searched first");
  assert.deepEqual(reviewsOfEntry([{ role: "reviewer", verdict: "pass", head: H, tree: "e".repeat(40), via: "same_tree" }, { role: "reviewer", verdict: "pass", head: H, tree: "nothex" }]).map((r) => [r.tree, r.via]), [["e".repeat(40), "same_tree"], [undefined, undefined]]);
});

// --- the git pack and the PR watch ----------------------------------------------------------------------------------------------------------------------

test("pr_create through the pack: cover is called with the checkout and the commit the PR names before the reviewed heads are read", async (t) => {
  const { w, g } = fresh(t);
  const top = fs.realpathSync.native(w.project);
  const h1 = g.git("rev-parse", "HEAD");
  const h2 = g.commit("same tree");
  g.git("branch", "feature", h2);
  g.git("reset", "-q", "--hard", h1);
  const order: string[] = [];
  const reviewed: string[] = [h1];
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ details: Record<string, unknown> }> }>();
  const spawner: Spawner = async () => ({ code: 0, stdout: JSON.stringify({ ok: true, action: "pr_create", number: 5, url: "https://github.com/acme/x/pull/5" }) + "\n", stderr: "", timedOut: false });
  const watches = new PrWatches({ send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 5000, now: () => 0 });
  const s: PrPackSession = {
    python: "/py", isChild: false, packOn: true, config: { baseBranch: "x", prHost: "auto" }, gateOn: true, watches, trace: () => {}, tracker: { hostAllowed: async () => true, repoFor: async () => ({ host: "github.com", repo: "acme/x" }) },
    cover: async (cwd, head) => { order.push(`cover ${cwd === top} ${head === h2}`); reviewed.push(head); },
    reviewed: async () => (order.push("reviewed"), reviewed),
  };
  registerPrPack({ registerTool: (d: unknown) => void tools.set((d as { name: string }).name, d as never) } as never, { isChild: false, session: async () => s, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null });
  const r = await tools.get("pr_create")!.execute("id", { title: "t", body: "b", head: "feature" }, undefined, undefined, { cwd: top });
  assert.equal(r.details.decision, "ran");
  assert.deepEqual(order.slice(0, 2), ["cover true true", "reviewed"]);
});

test("the PR watch covers its head at the tick: a same-tree commit pushed to an open PR counts as reviewed at the next tick", async () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => (fns.push(fn), fns.length), clear: () => {} };
  const reviews: ReviewRecord[] = [{ role: "reviewer", verdict: "pass", head: A, kind: "code", occasion: "pre-pr", cwd: "/co", tree: "e".repeat(40) }];
  const covered: string[] = [];
  const snap = (head: string): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head, base: "main", updatedAt: "t", runs: [{ id: "1", name: "ci", bucket: "passed", url: "u" }], comments: [], draft: false });
  const read = { v: { kind: "entry", snap: snap(A), okAt: 1000 } as StoreRead };
  const watches: PrWatches = new PrWatches({
    storeEntry: () => read.v,
    githubHosts: () => ({ hosts: ["ghe.example.com"] }),
    reviewedHeads: () => passHeads(reviews),
    reviewFacts: (head) => reviewFactsForHead(reviews, head, []),
    cover: async (head) => {
      covered.push(head);
      reviews.push({ ...reviews[0], head, via: "same_tree" });
    },
    persist: () => {}, cwd: () => "/work", child: () => false, send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 60_000, settleMs: () => 0, now: () => 0, timers,
  });
  watches.start({ host: "ghe.example.com", repo: "acme/app", n: 7 }, snap(A), null, true);
  read.v = { kind: "entry", snap: snap(B), okAt: 2000 };
  fns.shift()?.();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(covered, [B]);
  assert.equal(watches.reviewLive()[0]?.state, "ok", "the same-tree head is reviewed");
});

test("pr_status covers the head of the answer before it reads the reviewed heads", async () => {
  const H = "c".repeat(40);
  const reviewed: string[] = [];
  const seen: string[] = [];
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> }>();
  const spawner: Spawner = async () => ({ code: 0, stdout: JSON.stringify({ ok: true, action: "pr_status", number: 5, url: "https://github.com/acme/x/pull/5", headSha: H }) + "\n", stderr: "", timedOut: false });
  const watches = new PrWatches({ send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 5000, now: () => 0 });
  const s: PrPackSession = {
    python: "/py", isChild: false, packOn: true, config: { baseBranch: "x", prHost: "auto" }, gateOn: true, watches, trace: () => {}, tracker: { hostAllowed: async () => true, repoFor: async () => ({ host: "github.com", repo: "acme/x" }) },
    cover: async (cwd, head) => void (seen.push(`${cwd} ${head}`), reviewed.push(head)),
    reviewed: async () => reviewed,
  };
  registerPrPack({ registerTool: (d: unknown) => void tools.set((d as { name: string }).name, d as never) } as never, { isChild: false, session: async () => s, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null });
  const r = await tools.get("pr_status")!.execute("id", { number: 5 }, undefined, undefined, { cwd: "/work" });
  assert.deepEqual(seen, [`/work ${H}`]);
  assert.match(r.content[0].text, /head cccccccc reviewed|reviewed/);
  assert.doesNotMatch(r.content[0].text, /not reviewed|no review record/);
});
