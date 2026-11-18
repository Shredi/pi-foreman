// The review verdict record across a reload, a headless parent and a session restart (plan structured-verdicts §7): the route entry of a review
// launch lets the completion notice after a reload mark the record's items (and mark nothing for a plan review), a resume keeps its record
// for a headless parent with `childAsk: deny`, a session restart removes the old record folder and its next review gets a new one, a policy block is read only from
// the error fields, and the FAIL re-review line also comes from a record the completion notice read.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { runEndOf } from "../launchwait.ts";
import { tick, world, type WorldOpts } from "./_r46world.ts";
import { bindingOf } from "./_verdict-rig.ts";

type W = ReturnType<typeof world>;
type Rig = Awaited<ReturnType<W["adapter"]>>;

const LEDGER = "# Ledger: x\nTier: standard\n\n- [ ] 1. first\n- [ ] 2. second\n- [ ] 3. third\n- [ ] V. verify\n";
const ledgerOf = (w: W): string => fs.readFileSync(path.join(w.project, ".workflow", "LEDGER-x.md"), "utf8");
const marked = (w: W, n: number | string): boolean => new RegExp(`- \\[x\\] ${n}\\. `).test(ledgerOf(w));
async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await tick(50);
}
const noticeOf = (runId: string): string => `Background task completed: **reviewer**\n\nsee the record\n\nRetention-managed async directory: /x/async/${runId}\n`;
const notice = (a: Rig, runId: string) => a.fire("message_end", { message: { role: "custom", customType: "subagent-notify", content: noticeOf(runId) } });
const endOf = (runId: string) => ({ runId, agent: "reviewer", success: true, status: "completed", results: [{ agent: "reviewer", status: "completed", success: true, output: "see the record" }] });

async function setup(t: Parameters<typeof world>[0], o: WorldOpts = {}) {
  const w = world(t, { ceremony: { default: "standard" }, ...o });
  const a = await w.adapter("startup");
  await a.writeLedger(LEDGER);
  return { w, a };
}

/** A resume of `target` as the foreman launches it: the call, its hook and the result with the new run id. */
async function resume(a: Rig, target: string, runId: string): Promise<string | null> {
  const id = `res-${runId}`;
  const input = { action: "resume", id: target, message: "finish the review" };
  await a.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } });
  const res = (await a.fire("tool_call", { toolName: "subagent", toolCallId: id, input })) as { block?: boolean; reason?: string } | undefined;
  if (res?.block) return res.reason ?? "blocked";
  await a.fire("tool_result", { toolName: "subagent", toolCallId: id, input, details: { runId }, content: [{ type: "text", text: "started" }], isError: false });
  return null;
}

test("after a reload the completion notice of a reviewer run marks the record's items; one of a [plan-review] launch marks nothing", async (t) => {
  const { w, a } = await setup(t);
  const plan = await a.reviewLaunch();
  assert.equal(plan.blocked, null, String(plan.blocked));
  const items = await a.reviewLaunch("[pre-pr] review the items", { items: [1, 2] });
  assert.equal(items.blocked, null, String(items.blocked));
  assert.ok(a.record(plan.id, { verdict: "pass" }));
  assert.ok(a.record(items.id, { verdict: "pass", items: [{ id: 1, result: "pass" }, { id: 2, result: "open", note: "not run" }] }));
  const routes = w.entries.filter((e) => e.customType === "pi-foreman-ledger-route").map((e) => e.data as { run: string; review?: { launch: string; items: unknown[]; occasion: string } });
  const route = routes.find((r) => r.run === `run-${items.id}`);
  assert.equal(route?.review?.launch, bindingOf(a.inputOf(items.id))?.launchId, "the route entry carries the launch id");
  assert.deepEqual(route?.review?.items, [1, 2]);
  const b = await w.adapter("reload");
  await notice(b, `run-${plan.id}`);
  await notice(b, `run-${items.id}`);
  await until(() => marked(w, 1));
  assert.ok(marked(w, 1), ledgerOf(w));
  assert.ok(!marked(w, 2) && !marked(w, 3) && !marked(w, "V"), `only the passed item is marked:\n${ledgerOf(w)}`);
  assert.equal((await w.traceEvents()).filter((e) => e.event === "ledger_mark_by_review").length, 1, "the plan review marked nothing");
});

test("a resume with a headless parent and childAsk deny keeps the route and its record counts", async (t) => {
  const { w, a } = await setup(t, { headless: true, config: { gate: { childAsk: "deny" } } });
  const first = await a.reviewLaunch("[pre-pr] review the items", { items: [1] });
  assert.equal(first.blocked, null, String(first.blocked));
  const dir = bindingOf(a.inputOf(first.id))?.verdictDir ?? "";
  assert.ok(dir && fs.existsSync(dir), "a record folder for a headless parent");
  await a.endRunRecord(first.id, { verdict: "fail", items: [{ id: 1, result: "fail", note: "broken" }], findings: [{ kind: "defect", text: "broken", file: "src/a.ts", line: 3 }] });
  await tick(300);
  assert.ok(!marked(w, 1));
  assert.equal(await resume(a, `run-${first.id}`, "run-resumed"), null);
  const route = w.entries.map((e) => e.data as { run?: string; review?: { launch: string; occasion: string } }).find((d) => d.run === "run-resumed");
  assert.equal(route?.review?.launch, bindingOf(a.inputOf(first.id))?.launchId, "the resumed run's route entry names the first launch");
  assert.ok(a.record(first.id, { verdict: "pass", items: [{ id: 1, result: "pass" }] }), "the folder still takes a new record");
  await a.endEvent(endOf("run-resumed"));
  await until(() => marked(w, 1));
  assert.ok(marked(w, 1), ledgerOf(w));
  assert.deepEqual((await w.traceEvents()).filter((e) => e.event === "review_done").map((e) => e.decision), ["fail", "pass"]);
});

// A resume of a run of an earlier process is refused today by the resume check (`actions.ts` resumeCheck: the run registry is process memory), so the
// hook never reaches the folder code for it; this case covers what a restart does reach: the old folder goes, a new review launch has its own.
test("after a session restart (shutdown, then a new adapter over the same session file) a new review launch gets its own record folder and its record counts", async (t) => {
  const { w, a } = await setup(t);
  const first = await a.reviewLaunch("[pre-pr] review the items", { items: [1] });
  assert.equal(first.blocked, null, String(first.blocked));
  const dir = bindingOf(a.inputOf(first.id))?.verdictDir ?? "";
  assert.ok(dir && fs.existsSync(dir));
  await a.endRunRecord(first.id, { verdict: "incomplete", reason: "stopped half way" });
  await tick(300);
  await a.down(); // the session ends: its record folder goes (the registration of its child extensions with it)
  assert.equal(fs.existsSync(dir), false, "the ended session removed its record folder");
  const b = await w.adapter("resume"); // pi --resume: a new process over the same session file
  const second = await b.reviewLaunch("[pre-pr] review the items", { items: [1] });
  assert.equal(second.blocked, null, String(second.blocked));
  const dir2 = bindingOf(b.inputOf(second.id))?.verdictDir ?? "";
  assert.ok(dir2 && fs.existsSync(dir2) && dir2 !== dir, "a new folder");
  await b.endRunRecord(second.id, { verdict: "pass", items: [{ id: 1, result: "pass" }] });
  await until(() => marked(w, 1));
  assert.ok(marked(w, 1), ledgerOf(w));
});

test("the policy block is read from the run end's error fields only: a reviewer's report text quoting a usage policy is none, the error field is one", () => {
  const sentence = "The provider declined this request under its usage policy.";
  const quoted = { runId: "q1", agent: "reviewer", success: false, summary: "report", results: [{ agent: "reviewer", status: "failed", success: false, output: sentence }] };
  assert.equal(runEndOf(quoted)?.policyBlock, undefined, "the final text is not read");
  assert.equal(runEndOf({ ...quoted, runId: "q2", summary: sentence })?.policyBlock, undefined, "the summary is not read");
  assert.equal(runEndOf({ ...quoted, runId: "q3", error: sentence })?.policyBlock, true, "the error field is");
  assert.equal(runEndOf({ ...quoted, runId: "q4", results: [{ agent: "reviewer", status: "failed", success: false, error: sentence, output: "no verdict" }] })?.policyBlock, true, "a result's error field is");
});

test("a FAIL record gives the re-review line of the next item review, also when the completion notice follows the run end", async (t) => {
  const { w, a } = await setup(t);
  const first = await a.reviewLaunch("review item 1", { items: [1, 2] });
  assert.equal(first.blocked, null, String(first.blocked));
  await a.endRunRecord(first.id, { verdict: "fail", items: [{ id: 2, result: "fail", note: "broken" }, { id: 1, result: "pass" }], findings: [{ kind: "defect", text: "broken", file: "src/a.ts", line: 3 }] });
  await notice(a, `run-${first.id}`); // the notice takes the cached record
  await tick(300);
  assert.ok(!marked(w, 1) && !marked(w, 2), "a FAIL marks nothing");
  const again = await a.reviewLaunch("review item 2");
  assert.equal(again.blocked, null, String(again.blocked));
  assert.match(again.task, /\[pi-foreman re-review\]/);
  assert.deepEqual(bindingOf(a.inputOf(again.id))?.items, [2]);
});
