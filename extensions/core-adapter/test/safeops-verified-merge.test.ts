import { test } from "node:test";
import assert from "node:assert/strict";
import { registerSafeOps } from "../safeops.ts";
import type { SafeOpOutcome, SafeOpsSession } from "../safeops.ts";
import { VERIFY_LOOKUP_TIMEOUT_MS, verifiedMergeFor } from "../selffinish.ts";
import type { VerifyLookupDeps } from "../selffinish.ts";
import type { Spawner } from "../spawn.ts";

const TIP = "a".repeat(40);
const ran = (result: Record<string, unknown>): SafeOpOutcome => ({ kind: "ran", result });

function lookup(opts: { branch?: string | null; prs?: Record<string, unknown>[] | null; status?: (n: number) => Record<string, unknown> | "fail" }) {
  const calls: { op: string; args: Record<string, unknown>; timeoutMs: number }[] = [];
  const deps: VerifyLookupDeps = {
    git: async (args) => (args[0] === "symbolic-ref" ? (opts.branch === undefined ? "feat" : opts.branch) : TIP),
    run: async (op, args, timeoutMs) => {
      calls.push({ op, args, timeoutMs });
      if (op === "pr_find") return opts.prs === null ? { kind: "error", message: "boom" } : ran({ prs: opts.prs ?? [] });
      const st = opts.status ? opts.status(args.number as number) : { state: "merged", headRefName: "feat", headSha: TIP };
      return st === "fail" ? { kind: "error", message: "timeout" } : ran(st);
    },
  };
  return { deps, calls };
}
const pr = (number: number, state: string, headRefName = "feat") => ({ number, state, headRefName });

test("verifiedMergeFor: a merged PR with the branch as head ref and the tip as head sha gives the fact", async () => {
  const h = lookup({ prs: [pr(7, "merged")] });
  assert.deepEqual(await verifiedMergeFor(h.deps), { sha: TIP, branch: "feat" });
  assert.deepEqual(h.calls.map((c) => c.op), ["pr_find", "pr_status"]);
  assert.deepEqual(h.calls[0].args, { head: "feat", state: "all" });
});

test("verifiedMergeFor: every host lookup gets the short timeout", async () => {
  const h = lookup({ prs: [pr(7, "merged")] });
  await verifiedMergeFor(h.deps);
  assert.ok(VERIFY_LOOKUP_TIMEOUT_MS <= 30_000);
  assert.deepEqual(h.calls.map((c) => c.timeoutMs), [VERIFY_LOOKUP_TIMEOUT_MS, VERIFY_LOOKUP_TIMEOUT_MS]);
});

test("verifiedMergeFor: no fact for an open PR, another sha, another head ref, a failed status or find, no PR, or a detached HEAD", async () => {
  assert.equal(await verifiedMergeFor(lookup({ prs: [pr(7, "open")] }).deps), undefined);
  assert.equal(await verifiedMergeFor(lookup({ prs: [pr(7, "merged")], status: () => ({ state: "merged", headRefName: "feat", headSha: "b".repeat(40) }) }).deps), undefined);
  assert.equal(await verifiedMergeFor(lookup({ prs: [pr(7, "merged")], status: () => ({ state: "merged", headRefName: "other", headSha: TIP }) }).deps), undefined);
  assert.equal(await verifiedMergeFor(lookup({ prs: [pr(7, "merged")], status: () => ({ state: "open", headRefName: "feat", headSha: TIP }) }).deps), undefined);
  assert.equal(await verifiedMergeFor(lookup({ prs: [pr(7, "merged")], status: () => "fail" }).deps), undefined);
  assert.equal(await verifiedMergeFor(lookup({ prs: null }).deps), undefined);
  assert.equal(await verifiedMergeFor(lookup({ prs: [] }).deps), undefined);
  assert.equal(await verifiedMergeFor(lookup({ prs: [pr(7, "merged")], branch: null }).deps), undefined);
  assert.equal(await verifiedMergeFor(lookup({ prs: [pr(7, "merged", "other")] }).deps), undefined);
});

test("verifiedMergeFor: with a closed and a merged PR for the branch, the fact comes from the merged one", async () => {
  const h = lookup({ prs: [pr(3, "closed"), pr(7, "merged")], status: (n) => (n === 7 ? { state: "merged", headRefName: "feat", headSha: TIP } : { state: "closed", headRefName: "feat", headSha: TIP }) });
  assert.deepEqual(await verifiedMergeFor(h.deps), { sha: TIP, branch: "feat" });
  assert.deepEqual(h.calls.filter((c) => c.op === "pr_status").map((c) => c.args.number), [7]);
});

test("verifiedMergeFor: a thrown run is no fact", async () => {
  const deps: VerifyLookupDeps = { git: async () => "feat", run: async () => { throw new Error("x"); } };
  assert.equal(await verifiedMergeFor(deps), undefined);
});

function wired(fact: { sha: string; branch: string } | undefined | "throw") {
  const inputs: string[] = [];
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<unknown> }>();
  const spawner: Spawner = async (_c, _a, o) => {
    inputs.push(o.input ?? "");
    return { code: 0, stdout: JSON.stringify({ ok: true, action: "worktree_remove" }), stderr: "", timedOut: false };
  };
  const session: SafeOpsSession = { python: "/py", isChild: false, opsConfig: {}, trace: () => {} };
  registerSafeOps({ registerTool: (t: unknown) => void tools.set((t as { name: string }).name, t as never) } as never, {
    isChild: false,
    session: async () => session,
    script: "s.py",
    spawner,
    env: () => ({}),
    verifiedMerge: async () => { if (fact === "throw") throw new Error("x"); return fact; },
  });
  const call = (name: string, params: Record<string, unknown>) => tools.get(name)!.execute("id", params, undefined, undefined, { cwd: "/ws" });
  return { inputs, call };
}

test("safeops: the fact travels as top-level verifiedMerged and verifiedBranch, only for worktree_remove", async () => {
  const h = wired({ sha: TIP, branch: "feat" });
  await h.call("foreman_worktree_remove", { path: "wt" });
  const req = JSON.parse(h.inputs[0]);
  assert.equal(req.verifiedMerged, TIP);
  assert.equal(req.verifiedBranch, "feat");
  assert.deepEqual(req.args, { path: "wt" });
  await h.call("foreman_move", { src: "a", dst: "b" });
  assert.equal("verifiedMerged" in JSON.parse(h.inputs[1]), false);
});

test("safeops: without a fact, or when the lookup throws, the request has no verifiedMerged key", async () => {
  for (const f of [undefined, "throw"] as const) {
    const h = wired(f);
    await h.call("foreman_worktree_remove", { path: "wt" });
    const req = JSON.parse(h.inputs[0]);
    assert.equal("verifiedMerged" in req, false);
    assert.equal("verifiedBranch" in req, false);
  }
});

test("safeops: a verifiedMerged key in the model's args stays in args only", async () => {
  const h = wired(undefined);
  await h.call("foreman_worktree_remove", { path: "wt", verifiedMerged: TIP });
  const req = JSON.parse(h.inputs[0]);
  assert.equal("verifiedMerged" in req, false);
});
