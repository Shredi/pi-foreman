// ceremony.recheckBudget is gone: after a reviewer PASS the foreman's own read/bash calls are never refused. A commit or
// project edit after the PASS still makes the review stale through the sha-based PR gate (reviews.ts), not through a count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

test("after a reviewer PASS, more than 3 own read/bash calls incl. merge and run rerun are allowed", async (t) => {
  const a = await r11Rig(t, {}, reviewAllowOpts());
  await a.notice("Background task completed: **reviewer**\nOverall verdict: PASS");
  const sha = "a".repeat(40);
  const commands = ["ls one", "cat notes.md", "git diff", "git show HEAD", `gh pr merge 12 --squash --match-head-commit ${sha}`, "gh run rerun --failed", "ls six", "cat seven"];
  for (const command of commands) {
    const r = await a.toolDoing("bash", { command }, () => undefined);
    assert.ok(!(r?.block === true && /\[recheck_budget_exceeded\]/.test(r.reason ?? "")), `${command}: ${r?.reason}`);
  }
  assert.deepEqual(a.events("recheck_budget"), []);
});
