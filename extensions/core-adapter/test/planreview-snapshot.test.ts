// Plan re-review facts per launch (ledger item 5, D7): each `[plan-review]` launch keeps the plan text its reviewer reads; its verdict counts for that
// text's version only; a plan write in the same tool batch as a launch never reads "no difference".
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { PlanReviews } from "../planreview.ts";
import { LaunchBatch } from "../launchwait.ts";
import { PLAN, tick, world } from "./_r46world.ts";

const REL = ".workflow/scratch/plan-widget.md";
const V = (word: string) => PLAN.replace("Ship it.", word);

type Adapter = Awaited<ReturnType<ReturnType<typeof world>["adapter"]>>;
const TASK = `[plan-review] review ${REL}`;

/** One assistant message holding `extra` calls and, when `id` is given, a `[plan-review]` launch (hook order: the launch first, each extra call after it). */
async function message(a: Adapter, id: string | null, extra: { id: string; name: string; arguments: Record<string, unknown> }[] = []): Promise<Record<string, unknown> | null> {
  const input: Record<string, unknown> = { agent: "reviewer", task: TASK };
  const calls = [...(id ? [{ type: "toolCall", id, name: "subagent", arguments: input }] : []), ...extra.map((c) => ({ type: "toolCall", ...c }))];
  await a.fire("message_end", { message: { role: "assistant", content: calls } });
  if (!id) return null;
  assert.equal(await a.fire("tool_call", { toolName: "subagent", toolCallId: id, input }), undefined);
  return input;
}
const started = (a: Adapter, id: string, input: Record<string, unknown>) =>
  a.fire("tool_result", { toolName: "subagent", toolCallId: id, input, details: { runId: `run-${id}` }, content: [{ type: "text", text: "started" }], isError: false });
/** A foreman `write` of the plan: tool_call, the file, tool_result. */
async function write(a: Adapter, file: string, id: string, text: string): Promise<void> {
  const input = { path: REL, content: text };
  await a.fire("tool_call", { toolName: "write", toolCallId: id, input });
  fs.writeFileSync(file, text);
  await a.fire("tool_result", { toolName: "write", toolCallId: id, input, details: {}, content: [{ type: "text", text: "ok" }], isError: false });
}
const writeBatch = async (a: Adapter, file: string, id: string, text: string) => {
  await message(a, null, [{ id, name: "write", arguments: { path: REL, content: text } }]);
  await write(a, file, id, text);
};
/** A full launch (its own message) that has started. */

test("PlanReviews unit: a snapshot belongs to its launch; a refused launch drops it; only an open launch of the same batch is refreshed", () => {
  const r = new PlanReviews();
  const p = "/p/plan-a.md";
  r.noteLaunch(p, "h1", "one", 1, "c1");
  r.dropLaunch("c1"); // (b) the launch was refused or failed
  assert.equal(r.refreshLaunch(p, "h2", "two", 1), false, "a dropped launch is not refreshed");
  r.noteLaunch(p, "h1", "one", 1, "c2");
  assert.equal(r.refreshLaunch(p, "h2", "two", 2), false, "a write of a later batch is not the reviewer's");
  assert.equal(r.refreshLaunch(p, "h2", "two", 1), true, "(c) a write of the same batch");
  r.bindRun("c2", "run2");
  r.noteLaunch(p, "h3", "three", 2, "c3"); // a second launch does not overwrite the first one's snapshot
  r.bindRun("c3", "run3");
  assert.deepEqual(r.snapshotOf("run2", p), { hash: "h2", text: "two" });
  assert.deepEqual(r.snapshotOf("run3", p), { hash: "h3", text: "three" });
  assert.equal(r.keepRun(p, "run2")?.hash, "h2");
  assert.equal(r.reviewedText(p), "two");
  assert.equal(r.keepRun(p, "run9"), null, "no snapshot (after a reload): nothing kept");
});

test("LaunchBatch keeps the tool calls of the message", () => {
  const b = new LaunchBatch();
  b.onAssistant([{ type: "toolCall", id: "a", name: "write", arguments: { path: "x" } }, { type: "toolCall", id: "b", name: "subagent", arguments: {} }, { type: "text", text: "hi" }], () => true);
  assert.deepEqual(b.toolCalls.map((c) => c.name), ["write", "subagent"]);
});

test("T8a: a second launch before the first verdict: the first verdict counts for the text its reviewer read; a re-review diffs against the last verdict's text", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  const first = await a.reviewLaunch(); // run 1 reads PLAN (version A)
  assert.equal(first.blocked, null);
  await writeBatch(a, w.planFile, "w1", V("Ship it B."));
  const second = await a.reviewLaunch(); // run 2 reads version B, before run 1 ended
  assert.equal(second.blocked, null);
  a.endRun(first.id, "Overall verdict: PASS\n");
  await tick();
  assert.equal((await a.checkpoint()).decision, "refused", "run 1's PASS is for version A: the current version B is not reviewed");
  a.endRun(second.id, "Overall verdict: FAIL\n");
  await tick();
  await writeBatch(a, w.planFile, "w2", V("Ship it C."));
  const third = await a.reviewLaunch();
  assert.equal(third.blocked, null);
  assert.ok(!/no difference/.test(third.task), third.task);
  assert.match(third.task, /^-Ship it B\.$/m, "diffed against the text run 2 read");
  assert.match(third.task, /^\+Ship it C\.$/m);
});

test("T8b: a launch that failed to start leaves no snapshot: a later write is not taken as read; the re-review diffs against the last reviewed text", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  assert.equal(await a.review("PASS"), null); // reviewed text: PLAN
  const input = await message(a, "f1");
  await a.fire("tool_result", { toolName: "subagent", toolCallId: "f1", input, details: {}, content: [{ type: "text", text: "refused" }], isError: true });
  await writeBatch(a, w.planFile, "w1", V("Ship it later."));
  const re = await a.reviewLaunch();
  assert.equal(re.blocked, null);
  assert.match(re.task, /^-Ship it\.$/m);
  assert.match(re.task, /^\+Ship it later\.$/m);
});

test("T8c: a write in the tool batch of an open launch, after the launch hook, is the text its reviewer reads and the version its verdict counts for", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  const write1 = { id: "w1", name: "write", arguments: { path: REL, content: V("Ship it now.") } };
  const input = await message(a, "l1", [write1]); // facts computed from the old bytes, then the write lands
  await write(a, w.planFile, "w1", V("Ship it now."));
  await started(a, "l1", input!);
  a.endRun("l1", "Overall verdict: PASS\n");
  await tick();
  assert.notEqual((await a.checkpoint()).decision, "refused", "the verdict counts for the written version");
});

test("T8d: an edit of the plan and a [plan-review] launch in one assistant message: the facts carry the same-batch line, never 'no difference'", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  assert.equal(await a.review("FAIL"), null);
  const edit = { id: "e1", name: "edit", arguments: { path: REL, edits: [{ oldText: "Ship it.", newText: "Ship it better." }] } };
  const input = await message(a, "l2", [edit]); // the launch hook runs before the edit lands
  const task = String(input!.task);
  assert.ok(!/no difference/.test(task), task);
  assert.match(task, /the plan is written in the same tool batch as this launch; no diff at launch: review the whole plan against the earlier findings/);
  assert.match(task, /Re-review of/);
  await started(a, "l2", input!);
});

test("T8d: a plan edit in an earlier message than the launch still diffs; a write to another file in the same message does not add the line", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  assert.equal(await a.review("FAIL"), null);
  const other = { id: "o1", name: "write", arguments: { path: ".workflow/notes.md", content: "x" } };
  const input = await message(a, "l3", [other]);
  assert.match(String(input!.task), /no difference to the last reviewed version/);
  assert.ok(!/same tool batch/.test(String(input!.task)));
});
