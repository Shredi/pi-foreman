// Revision round of D117/D129: a same-tree alias never overrides a record at the head from another checkout; a sibling pr_create {cwd, head} hands the named
// branch's commit to the high-stakes gate; the review-tag defuse of the findings blocks runs until stable.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { prRefusal, findingsBlock } from "../highstakes.ts";
import type { HsState } from "../highstakes.ts";
import { earlierFindingsBlock } from "../ledgerblock.ts";
import { prGateRefusal } from "../reviews.ts";
import type { ReviewRecord } from "../reviews.ts";
import { coverAliases } from "../reviewcover.ts";
import { rmTestTmp } from "./_tmpbase.ts";

test("coverAliases: a FAIL at the head recorded in another checkout blocks the alias from a PASS on the same tree", async () => {
  const H = "a".repeat(40);
  const X = "b".repeat(40);
  const T = "e".repeat(40);
  const records: ReviewRecord[] = [
    { role: "reviewer", verdict: "pass", head: H, cwd: "/B", kind: "code", tree: T },
    { role: "reviewer", verdict: "fail", head: X, cwd: "/C", kind: "code", tree: T },
  ];
  const o = { blocked: () => false, treeOf: async () => T };
  assert.equal((await coverAliases(records, X, o)).length, 0);
  assert.equal((await coverAliases(records.slice(0, 1), X, o)).length, 1, "without the FAIL the alias is made");
});

test("sibling pr_create {cwd, head}: the named branch's commit reaches the high-stakes gate; a high-stakes FAIL at that commit in another checkout refuses", async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-rr-")));
  try {
    const A = path.join(root, "a");
    const B = path.join(root, "b");
    const g = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { encoding: "utf8" }).trim();
    fs.mkdirSync(A);
    g(A, "init", "-q", "-b", "main");
    g(A, "commit", "-q", "--allow-empty", "-m", "base");
    const X = g(A, "rev-parse", "HEAD");
    g(A, "branch", "brx");
    g(A, "worktree", "add", "-q", B, "-b", "bhead");
    g(B, "commit", "-q", "--allow-empty", "-m", "b2");
    const bHead = g(B, "rev-parse", "HEAD");
    const rec = (head: string): ReviewRecord => ({ role: "reviewer", verdict: "pass", head, cwd: B });
    const state: HsState = { fired: null, runIds: [], bases: {}, runs: [{ verdict: "fail", head: X, cwd: A, revised: false, handed: false, cleared: false }] };
    const seen: string[][] = [];
    const hs = async (scope: string | null, heads: readonly string[]) => {
      seen.push([...heads]);
      return prRefusal(state, [], heads, A, scope === null ? undefined : [scope]);
    };
    const gate = (input: Record<string, unknown>) => prGateRefusal({ tool: "pr_create", isChild: false, gateOn: true, reviewed: [], cwd: A, input, checkout: { cwd: B, records: [rec(X), rec(bHead)] }, highStakes: hs });
    const refused = await gate({ head: "brx" });
    assert.equal(refused?.reason, "high_stakes_failed");
    assert.ok(seen.at(-1)?.includes(X) && seen.at(-1)?.includes(bHead));
    assert.equal(await gate({}), null, "B's own HEAD is not the FAIL head");
  } finally {
    rmTestTmp(root);
  }
});

test("the review-tag defuse of the findings blocks runs until stable: a nested tag leaves no tag", () => {
  const nested = "x [[pre-pr]] y [[[high-stakes]]] z [[second-opinion]] [[plan-review]]";
  for (const block of [findingsBlock(nested), earlierFindingsBlock(nested)]) {
    assert.doesNotMatch(block, /\[(high-stakes|pre-pr|second-opinion|plan-review)\]/i);
    assert.match(block, /\[\[?\[?pre-pr\]|pre-pr/);
  }
});
