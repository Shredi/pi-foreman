// R29 item 4: a foreman launch returns at once with its receipt and one line; the child's completion notice then carries the report.
// The block hook (`ceremony.launchWait: "block"`, the replay rigs' and bench's) still holds the launch until the run ends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeNotices, deliveredRuns, detachedLaunchLine } from "../launchwait.ts";
import { r11Rig } from "./_r11rig.ts";

const input = { agent: "builder", task: "build it" };
const textOf = (res: unknown): string => ((res as { content?: { text: string }[] } | undefined)?.content ?? []).map((c) => c.text).join("\n");

test("r29 async launch: the receipt returns before the run ends, and the completion notice carries the report", async (t) => {
  const r = await r11Rig(t);
  const { id } = await r.launch(input);
  // the default is detach: this resolves at once, a held launch would wait for the run end that comes below
  const res = await r.started(id, input, "run-d");
  assert.equal(textOf(res).split("\n").at(-1), detachedLaunchLine({ runId: "run-d", role: "builder", resultPath: null }));
  assert.equal(r.events("launch_wait").length, 0);
  const receipt = { role: "toolResult", toolName: "subagent", isError: false, details: { runId: "run-d" }, content: (res as { content: unknown[] }).content };
  assert.deepEqual(deliveredRuns(receipt), [], "a receipt delivers no report, so its notice stays in the context");
  r.end({ runId: "run-d", agent: "builder", success: true, summary: "built", asyncDir: "/tmp/x/run-d" });
  const report = "Background task completed: **builder**\n\nbuilder:\nbuilt the thing\n\nRetention-managed async directory: /tmp/x/run-d\n";
  await r.notice(report);
  assert.equal(dedupeNotices([receipt, { role: "custom", customType: "subagent-notify", content: report }]), null);
});

test("r29 async launch: the block hook holds the launch until the run ends", async (t) => {
  const r = await r11Rig(t, { launchWait: "block" });
  const { id } = await r.launch(input);
  const held = r.started(id, input, "run-b");
  r.end({ runId: "run-b", agent: "builder", success: true, summary: "built", asyncDir: "/tmp/x/run-b" });
  const res = await held;
  assert.match(textOf(res), /pi-foreman launch-wait: run run-b \(builder\) ended completed/);
  assert.equal(r.events("launch_wait")[0]?.outcome, "done");
});
