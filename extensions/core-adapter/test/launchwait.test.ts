import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeNotices, dedupeOn, LaunchBatch, launchWaitMode, launchWaitText, LaunchWaits, noticeRuns, runEndOf } from "../launchwait.ts";

const DIR = "/tmp/pi-subagents-uid-1/async-subagent-runs/run-a";
const notice = (role: string, dir: string) => `Background task completed: **${role}**\n\n${role}:\nlong child report\n\nRetention-managed async directory: ${dir}\n\nSession file: /x/session.jsonl`;

test("launchwait: config readers default to block and dedupe on", () => {
  assert.equal(launchWaitMode(undefined), "block");
  assert.equal(launchWaitMode("bogus"), "block");
  assert.equal(launchWaitMode("detach"), "detach");
  assert.equal(dedupeOn(undefined), true);
  assert.equal(dedupeOn(false), false);
});

test("launchwait: run end, supervisor request, timeout and abort end a wait", async () => {
  const w = new LaunchWaits();
  const done = w.wait("r1", 60_000);
  w.onRunEnd({ runId: "r1", agent: "builder", success: true, summary: "built", asyncDir: DIR });
  const d = await done;
  assert.equal(d.outcome, "done");
  assert.deepEqual(d.end, { runId: "r1", status: "completed", role: "builder", summary: "built", resultPath: DIR });
  // a run that ended before the wait started resolves at once
  assert.equal((await w.wait("r1", 60_000)).outcome, "done");

  const sup = w.wait("r2", 60_000);
  w.onSupervisorRequest({ requestId: "q", runId: "r2" });
  assert.equal((await sup).outcome, "supervisor");
  // a request that came just before the wait started is not lost
  w.onSupervisorRequest({ runId: "r3" });
  assert.equal((await w.wait("r3", 60_000)).outcome, "supervisor");

  assert.equal((await w.wait("r4", 5)).outcome, "timeout");

  const ac = new AbortController();
  const ab = w.wait("r5", 60_000, ac.signal);
  ac.abort();
  assert.equal((await ab).outcome, "abort");
  const shut = w.wait("r6", 60_000);
  w.abortAll();
  assert.equal((await shut).outcome, "abort");
  assert.equal(w.holding, 0);
  assert.equal(runEndOf({ runId: "r7", success: false, state: "stopped" })?.status, "stopped");
});

test("launchwait: in a sequential batch only the last launch is held", () => {
  const b = new LaunchBatch();
  const content = [
    { type: "toolCall", id: "c1", name: "subagent", arguments: { agent: "builder", task: "a" } },
    { type: "toolCall", id: "c2", name: "subagent", arguments: { action: "status", id: "x" } },
    { type: "toolCall", id: "c3", name: "subagent", arguments: { agent: "explorer", task: "b" } },
  ];
  b.onAssistant(content, (a) => !(a as { action?: string }).action);
  b.onToolCall("c1");
  assert.equal(b.mayHold("c1"), false, "c3 has not started: sequential execution");
  b.onToolCall("c3");
  assert.equal(b.mayHold("c1"), true, "every launch started: parallel execution");
  assert.equal(b.mayHold("c3"), true);
  assert.equal(b.mayHold("c2"), false, "status is no launch");
  assert.equal(b.mayHold("c1/1"), false, "nested codemode calls are not held");
});

test("launchwait: outcome texts name the run, the next step and the result path", () => {
  const base = { runId: "r1", role: "builder", ms: 61_000, maxSeconds: 900, asyncDir: DIR };
  const done = launchWaitText({ ...base, outcome: "done", end: { runId: "r1", status: "completed", role: "builder", summary: "all built", resultPath: DIR } });
  assert.match(done, /^pi-foreman launch-wait: run r1 \(builder\) ended completed after 61s\. Result path: .*run-a\. No bg_wait is needed/);
  assert.match(done, /all built$/);
  assert.match(launchWaitText({ ...base, outcome: "supervisor" }), /Answer it with subagent_supervisor, then bg_wait r1\./);
  const timeout = launchWaitText({ ...base, outcome: "timeout" });
  assert.match(timeout, /still running after 900s \(wait\.maxSeconds\); this is not a failure\. Continue with bg_wait r1\./);
  assert.doesNotMatch(timeout, /failed/i);
  assert.match(launchWaitText({ ...base, outcome: "abort" }), /keeps running detached .* Result path: .*run-a\./);
});

test("launchwait: dedupe stubs a notice only after its result was delivered, deterministically", () => {
  const launchResult = { role: "toolResult", toolName: "subagent", content: [{ type: "text", text: "Async: builder [run-a]\npi-foreman launch-wait: run run-a (builder) ended completed after 3s. Result path: x." }] };
  const n = { role: "custom", customType: "subagent-notify", content: notice("builder", DIR), display: false, timestamp: 1 };
  const user = { role: "user", content: "go", timestamp: 0 };
  assert.deepEqual(noticeRuns(n.content), { ids: ["run-a"], lines: [`Retention-managed async directory: ${DIR}`] });
  // notice before any delivery: unchanged
  assert.equal(dedupeNotices([user, n, launchResult]), null);
  const msgs = [user, launchResult, n];
  const r = dedupeNotices(msgs);
  assert.ok(r);
  assert.deepEqual(r.deduped, ["run-a"]);
  const stub = (r.messages[2] as { content: string }).content;
  assert.equal(stub, `Background task completed: **builder** [pi-foreman: notice shortened, the result of run run-a was already delivered above. Retention-managed async directory: ${DIR}]`);
  assert.equal(r.messages[0], user, "earlier messages are the same objects");
  assert.deepEqual(dedupeNotices(msgs), r, "same history, same output");
  assert.equal(msgs[2], n, "input not mutated");
  // a bg_wait result names only an archive path: the notice after it stays intact
  const bg = { role: "toolResult", toolName: "bg_wait", content: [{ type: "text", text: `Waited 1s for run "run-a"; done.\nResult [run-a]: /r/run-a.json\n` }] };
  assert.equal(dedupeNotices([user, bg, n]), null);
  // a supervisor or timeout launch-wait result is no delivery
  const sup = { ...launchResult, content: [{ type: "text", text: "pi-foreman launch-wait: run run-a (builder) is still running and the child asks you something" }] };
  assert.equal(dedupeNotices([user, sup, n]), null);
});
