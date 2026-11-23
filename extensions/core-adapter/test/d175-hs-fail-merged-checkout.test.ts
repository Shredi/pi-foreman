// D175: a high-stakes FAIL in another checkout whose branch is merged does not block pr_create from a checkout with a pre-pr PASS.
import assert from "node:assert/strict";
import { test } from "node:test";
import { build, commitIn, git, hsRun, pr, setup, tick, worktree } from "./_hsrig.ts";

test("a high-stakes FAIL in checkout B (its branch merged into A's) does not refuse pr_create from A with a pre-pr PASS on its head", async (t) => {
  const { w, a } = await setup(t);
  w.state.answer = "allow once";
  const b = worktree(w, "wtb");
  commitIn(b, "src/b/x.ts");
  await build(a, {}, b);
  await hsRun(a, "FAIL", b);
  await tick(300);
  const runs = (w.ceremonyEntries().at(-1)!.data as { highStakes?: { runs?: { verdict?: string }[] } }).highStakes?.runs ?? [];
  assert.ok(runs.some((r) => r.verdict === "fail"), "the FAIL is recorded");
  git(w.project, "merge", "-q", "--no-edit", "wtb"); // B's branch lands in A's checkout
  await build(a);
  await tick(300);
  assert.equal(await pr(a), "", "the FAIL ran in B; A has its own PASS on the merged head");
});
