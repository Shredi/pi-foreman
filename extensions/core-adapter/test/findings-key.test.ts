// The findings `record` call carries the workspace key, repository and branch of the checkout the review ran in (findings.ts recordArgs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordArgs } from "../findings.ts";
import type { ReviewResult } from "../occasion.ts";

const result = { model: "p/m", rung: 0, primary: true, role: "reviewer", occasion: "item", verdict: "pass", index: 0 } as unknown as ReviewResult;
const ctx = { session: "s1", agentDir: "/agent", runId: "run1", cwd: "/w", head: "abc", live: null, now: 2000 };
const flag = (args: string[], name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

test("recordArgs passes workspace, repo and branch when known", () => {
  const args = recordArgs(result, null, { ...ctx, workspace: "proj-1a2b3c4d", repo: "acme/widgets", branch: "feature/x" });
  assert.equal(flag(args, "--workspace"), "proj-1a2b3c4d");
  assert.equal(flag(args, "--repo"), "acme/widgets");
  assert.equal(flag(args, "--branch"), "feature/x");
});

test("recordArgs leaves the flags out when a value is unknown", () => {
  const args = recordArgs(result, null, { ...ctx, workspace: null, repo: null, branch: null });
  for (const f of ["--workspace", "--repo", "--branch"]) assert.equal(args.includes(f), false, f);
  assert.deepEqual(recordArgs(result, null, ctx), args);
});
