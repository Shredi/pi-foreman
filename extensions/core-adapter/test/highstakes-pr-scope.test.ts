// D129: a high-stakes FAIL binds to its own checkout for pull requests (highstakes.ts prRefusal `scopes`, readyOverride `headCheckouts`; index.ts hsGate).
// The finish hold stays session-wide (highstakes-wiring-checkouts.test.ts keeps that pin).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { emptyState, readyOverride, prRefusal, type HsRun, type HsState } from "../highstakes.ts";
import { buildCeremonyState, CEREMONY_ENTRY } from "../planstate.ts";
import { prGateRefusal, type ReviewRecord } from "../reviews.ts";
import { commitIn, git, pr, setup, worktree } from "./_hsrig.ts";

const A = "/w/a";
const B = "/w/b";
const H = "c".repeat(40);
const failRun = (cwd: string, head: string | null = H): HsRun => ({ verdict: "fail", head, cwd, revised: false, handed: false, cleared: false });
const state = (runs: HsRun[]): HsState => ({ ...emptyState(), fired: { reasons: ["design"] }, runs });

test("prRefusal with scopes: a FAIL in checkout A holds a PR of A and not a PR of B; without scopes it holds every PR of the session", () => {
  const st = state([failRun(A)]);
  const heads = ["d".repeat(40)];
  assert.match(prRefusal(st, [], heads, B, [A])?.message ?? "", /\[pr_refused:high_stakes_failed\]/);
  assert.equal(prRefusal(st, [], heads, B, [B]), null);
  assert.match(prRefusal(st, [], heads, B)?.message ?? "", /high_stakes_failed/, "no scopes: session-wide, as before");
  assert.match(prRefusal(st, [], [H], B, [B])?.message ?? "", /head .* is the head of a high-stakes FAIL/, "the head of the FAIL stays refused from any checkout");
});

test("readyOverride: a head reviewed only in B is not held by a FAIL in A; a head of unknown checkout is held; a head reviewed in A is held; the failed head is held", () => {
  const st = state([failRun(A)]);
  const other = "d".repeat(40);
  assert.equal(readyOverride(st, [], other, [B]), null);
  assert.equal(readyOverride(st, [], other, []), "wip", "no record names the head");
  assert.equal(readyOverride(st, [], other), "wip", "no checkout list: as before");
  assert.equal(readyOverride(st, [], other, [B, A]), "wip");
  assert.equal(readyOverride(st, [], H, [B]), "wip", "the head of the FAIL");
});

test("pr_create {cwd}: a FAIL in checkout A with a pre-pr PASS in B: the PR from B passes, the PR from A is refused (the sibling gate)", async () => {
  const own = "/w/own";
  // the head test needs real checkouts: two repositories, as the sibling gate tests do
  const mk = (n: string) => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `pf-hs-${n}-`)));
    const g = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { encoding: "utf8" }).trim();
    g("init", "-q");
    g("commit", "-q", "--allow-empty", "-m", "a");
    return { dir, head: g("rev-parse", "HEAD") };
  };
  const a = mk("a");
  const b = mk("b");
  try {
    const fail = state([failRun(fs.realpathSync.native(a.dir), "e".repeat(40))]);
    const gate = (dir: string, mine: { dir: string; head: string }) =>
      prGateRefusal({ tool: "pr_create", isChild: false, gateOn: true, reviewed: [], cwd: "/nonexistent-session", input: {}, checkout: { cwd: dir, records: [{ role: "reviewer", verdict: "pass", head: mine.head, cwd: mine.dir, kind: "code", occasion: "pre-pr" } as ReviewRecord] }, highStakes: (scope, heads) => Promise.resolve(prRefusal(fail, [], heads, own, [scope ?? own])) });
    assert.equal(await gate(b.dir, b), null, "from B");
    assert.match((await gate(a.dir, a))?.message ?? "", /\[pr_refused:high_stakes_failed\]/, "from A");
  } finally {
    fs.rmSync(a.dir, { recursive: true, force: true });
    fs.rmSync(b.dir, { recursive: true, force: true });
  }
});

test("adapter: a FAIL that ran in a sibling worktree does not hold a PR from the session checkout; a PR naming a branch reviewed in the FAIL's checkout is refused", async (t) => {
  const { w, a } = await setup(t);
  const sib = worktree(w, "sib");
  commitIn(sib, "src/b/x.ts");
  const x1 = git(sib, "rev-parse", "HEAD");
  commitIn(sib, "src/b/y.ts");
  const x2 = git(sib, "rev-parse", "HEAD");
  const own = fs.realpathSync.native(w.project);
  const ownHead = git(w.project, "rev-parse", "HEAD");
  const reviews: ReviewRecord[] = [
    { role: "reviewer", verdict: "pass", head: ownHead, cwd: own, kind: "code", occasion: "pre-pr" },
    { role: "reviewer", verdict: "pass", head: x1, cwd: sib, kind: "code", occasion: "pre-pr" },
  ];
  await a.down();
  w.entries.splice(0);
  w.entries.push({ type: "custom", customType: CEREMONY_ENTRY, data: buildCeremonyState({ plan: null, lineages: [], planPhase: false, reviews, highStakes: state([failRun(sib, x2)]) }) });
  const b = await w.adapter("reload");
  assert.equal(await pr(b), "", "the session checkout: the FAIL ran elsewhere");
  assert.match(await pr(b, { head: "sib~1" }), /\[pr_refused:high_stakes_failed\][\s\S]*checkout .*sib/, "a branch whose commit was reviewed in the FAIL's checkout");
  assert.match(await pr(b, { head: "sib" }), /\[pr_refused:/, "the failed head and the unreviewed tip");
});
