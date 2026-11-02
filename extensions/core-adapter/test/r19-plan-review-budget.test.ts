// R19 item 2: a reviewer PASS on a plan-review occasion does not start the post-PASS recheck window; any other PASS does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig as baseRig, reviewAllowOpts } from "./_r11rig.ts";

const r11Rig = (t: Parameters<typeof baseRig>[0], ceremony: Record<string, unknown> = {}) => baseRig(t, ceremony, reviewAllowOpts());

type Rig = Awaited<ReturnType<typeof r11Rig>>;

const noticeOf = (agent: string, runId: string) =>
  `Background task completed: **${agent}**\nRetention-managed async directory: /tmp/async/${runId}\nOverall verdict: PASS`;
const recheckDenied = (r: { block?: boolean; reason?: string } | undefined): boolean => r?.block === true && /\[recheck_budget_exceeded\]/.test(r.reason ?? "");
const bash = (a: Rig, command: string) => a.toolDoing("bash", { command }, () => undefined);

/** Launch `input` as run `runId`, then deliver its PASS notice. */
async function passed(a: Rig, agent: string, task: string, runId: string): Promise<void> {
  const input = { agent, task };
  const { id } = await a.launch(input);
  await a.started(id, input, runId);
  await a.notice(noticeOf(agent, runId));
}
/** Three reads, then the fourth: the result of the fourth. */
async function fourth(a: Rig) {
  for (const c of ["ls one", "ls two", "ls three"]) assert.equal(await bash(a, c), undefined, c);
  return bash(a, "ls four");
}

test("plan_review_pass_keeps_the_normal_read_budget", async (t) => {
  const a = await r11Rig(t);
  await passed(a, "reviewer", "[plan-review] review plan-x.md", "run-plan");
  assert.equal(await fourth(a), undefined);
  assert.equal(a.events("recheck_budget").filter((r) => r.action === "start").length, 0);
});

test("code_review_pass_still_starts_the_recheck_window", async (t) => {
  const a = await r11Rig(t);
  await passed(a, "reviewer", "review items 1", "run-code");
  assert.ok(recheckDenied(await fourth(a)));
  assert.equal(a.events("recheck_budget").filter((r) => r.action === "start").length, 1);
});

test("pass_without_a_known_launch_still_starts_the_recheck_window", async (t) => {
  const a = await r11Rig(t);
  await a.notice(noticeOf("reviewer", "run-unknown"));
  assert.ok(recheckDenied(await fourth(a)));
});
