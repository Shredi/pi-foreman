import { test } from "node:test";
import assert from "node:assert/strict";
import { pollWatch, pollWatchBatch } from "../prwatch.ts";
import type { RunOp } from "../prwatch.ts";
import type { SafeOpOutcome } from "../safeops.ts";

const ran = (result: Record<string, unknown>): SafeOpOutcome => ({ kind: "ran", result }) as SafeOpOutcome;

function stub() {
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const run: RunOp = async (op, args) => {
    calls.push({ op, args });
    if (op === "pr_batch") {
      const prs = (args.prs as { repo: string; n: number }[]).map((p) => ({ repo: p.repo, number: p.n, state: "open", mergeable: "mergeable", headSha: "abc", baseRef: "main", updatedAt: "u1", runs: [] }));
      return ran({ prs, errors: [] });
    }
    if (op === "pr_status") return ran({ state: "open", mergeable: "mergeable", headSha: "abc", baseRef: "main", updatedAt: "u1" });
    if (op === "pr_checks") return ran({ failed: [], pending: [], passed: [] });
    return ran({ comments: [] });
  };
  return { run, calls };
}

const commentsCalls = (calls: { op: string; args: Record<string, unknown> }[]) => calls.filter((c) => c.op === "pr_comments").map((c) => c.args);

test("a batch watch of another repository asks pr_comments for that repository and host", async () => {
  const s = stub();
  await pollWatchBatch(s.run, [{ key: { host: "github.com", repo: "other/lib", n: 7 }, seen: { updatedAt: "" } }]);
  assert.deepEqual(commentsCalls(s.calls), [{ number: 7, repo: "other/lib", host: "github.com" }]);
});

test("an empty host passes no host to pr_comments", async () => {
  const s = stub();
  await pollWatchBatch(s.run, [{ key: { host: "", repo: "other/lib", n: 7 }, seen: { updatedAt: "" } }]);
  assert.deepEqual(commentsCalls(s.calls), [{ number: 7, repo: "other/lib" }]);
});

test("a watch polled one by one (no repository) passes neither repo nor host", async () => {
  const s = stub();
  await pollWatch(s.run, { host: "github.com", repo: "", n: 7 }, { updatedAt: "" });
  assert.deepEqual(s.calls.map((c) => c.op), ["pr_status", "pr_checks", "pr_comments"]);
  assert.deepEqual(commentsCalls(s.calls), [{ number: 7 }]);
});
