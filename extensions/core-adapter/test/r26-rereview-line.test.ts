// R26 item 3: a reviewer launched after an open FAIL gets the re-review line first, naming the head that FAIL reviewed;
// the first review, a `[pre-pr]` or `[second-opinion]` task and a task after an owner prompt get none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { r11Rig as baseRig, reviewAllowOpts } from "./_r11rig.ts";

const r11Rig = (t: Parameters<typeof baseRig>[0], ceremony: Record<string, unknown> = {}) => baseRig(t, ceremony, reviewAllowOpts());

const LINE = "[pi-foreman re-review] Review the revision diff since";
const newBuilder = () => ({ agent: "builder", task: "build it" });
const reviewer = () => ({ agent: "reviewer", task: "review items 1" });
const FAIL = "Overall verdict: FAIL\n1. the parser drops the last line\n";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();

/** A builder, then a reviewer that ends with `verdict` (FAIL output or PASS); returns the rig. */
async function reviewed(t: Parameters<typeof r11Rig>[0], verdict: "fail" | "pass", git_ = true) {
  const a = await r11Rig(t, { default: "standard", revisionRounds: { standard: 1 } });
  if (git_) {
    git(a.project, "init", "-q");
    git(a.project, "commit", "-q", "--allow-empty", "-m", "base");
  }
  const builder = newBuilder();
  const b = await a.launch(builder);
  assert.equal(b.res, undefined);
  await a.started(b.id, builder, "run-b");
  a.end({ runId: "run-b", agent: "builder", status: "completed", success: true, summary: "built" });
  const r = reviewer();
  const first = await a.launch(r);
  await a.started(first.id, r, "run-r1");
  a.end({ runId: "run-r1", agent: "reviewer", status: "completed", success: true, output: verdict === "fail" ? FAIL : "Overall verdict: PASS\n" });
  return a;
}

test("r26 re-review: after a FAIL the next reviewer task names the reviewed head", async (t) => {
  const a = await reviewed(t, "fail");
  const head = git(a.project, "rev-parse", "HEAD");
  const next = reviewer();
  await a.launch(next);
  assert.ok(next.task.startsWith(`${LINE} ${head} and run only the targeted tests the task names; do not run tsc or full suites (the foreman reports them).\n`), next.task);
  assert.match(next.task, /\nreview items 1\n/);
});

test("r26 re-review: the first review of the work gets no line", async (t) => {
  const a = await r11Rig(t, { default: "standard", revisionRounds: { standard: 1 } });
  const builder = newBuilder();
  const b = await a.launch(builder);
  await a.started(b.id, builder, "run-b");
  a.end({ runId: "run-b", agent: "builder", status: "completed", success: true, summary: "built" });
  const r = reviewer();
  await a.launch(r);
  assert.doesNotMatch(r.task, /re-review\]/);
});

test("r26 re-review: a [pre-pr] task after a FAIL gets no line", async (t) => {
  const a = await reviewed(t, "fail");
  const pre = { agent: "reviewer", task: "[pre-pr] review the whole branch" };
  const res = await a.launch(pre);
  assert.equal(res.res, undefined);
  assert.doesNotMatch(pre.task, /pi-foreman re-review\]/);
});

test("r26 re-review: a [second-opinion] task after a FAIL gets no line", async (t) => {
  const a = await reviewed(t, "fail");
  const second = { agent: "reviewer", task: "[second-opinion] a look at the parser" };
  const res = await a.launch(second);
  assert.equal(res.res, undefined);
  assert.doesNotMatch(second.task, /pi-foreman re-review\]/);
});

test("r26 re-review: a [plan-review] task after a FAIL gets no line", async (t) => {
  const a = await reviewed(t, "fail");
  const plan = { agent: "reviewer", task: "[plan-review] the plan" };
  await a.launch(plan);
  assert.doesNotMatch(plan.task, /pi-foreman re-review\]/);
});

test("r26 re-review: without a readable head the line says the reviewed head", async (t) => {
  const a = await reviewed(t, "fail", false);
  const next = reviewer();
  await a.launch(next);
  assert.ok(next.task.startsWith(`${LINE} the reviewed head and run only`), next.task);
});

test("r26 re-review: an owner prompt after a FAIL clears the line", async (t) => {
  const a = await reviewed(t, "fail");
  await a.ownerPrompt("next item");
  const next = reviewer();
  await a.launch(next);
  assert.doesNotMatch(next.task, /pi-foreman re-review\]/);
});
