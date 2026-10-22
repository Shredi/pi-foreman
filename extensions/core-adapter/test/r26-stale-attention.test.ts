// R26 item 2: a subagent wake that carries only needs-attention notices for runs already ended starts no turn (`handled`, trace
// `notify_deduped {reason: "run_ended"}`); a live run's notice or any other unseen message keeps the turn (`continue`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SUBAGENT_WAKE_TEXT } from "../idlecustom.ts";
import { r11Rig } from "./_r11rig.ts";

const notice = (runId: string) => ({
  customType: "subagent_control_notice",
  content: "tool 'bash' open for 240s",
  details: { event: { type: "needs_attention", reason: "tool_open_threshold", runId, toolCallId: "c1" } },
});
const entry = (msg: { customType: string; content: unknown; details: unknown }) => ({ type: "custom_message", ...msg });
const endRun = (r: { channel: (name: string, data: unknown) => unknown }, runId: string) =>
  r.channel("subagent:async-complete", { runId, agent: "builder", status: "completed", success: true, summary: "done" });

test("r26 stale attention: a wake with only ended-run notices is handled and traced once per notice", async (t) => {
  const r = await r11Rig(t);
  const branch: unknown[] = [];
  Object.assign(r.ctx.sessionManager, { getBranch: () => branch });
  endRun(r, "run-ended");
  branch.push(entry(notice("run-ended")), entry(notice("run-ended")));
  assert.deepEqual(await r.inputRun("extension", SUBAGENT_WAKE_TEXT), { action: "handled" });
  assert.deepEqual(
    r.events("notify_deduped").map((e) => [e.reason, e.runId]),
    [["run_ended", "run-ended"], ["run_ended", "run-ended"]],
  );
});

test("r26 stale attention: a wake with a live run's notice continues", async (t) => {
  const r = await r11Rig(t);
  const branch: unknown[] = [];
  Object.assign(r.ctx.sessionManager, { getBranch: () => branch });
  endRun(r, "run-ended");
  branch.push(entry(notice("run-live")));
  assert.deepEqual(await r.inputRun("extension", SUBAGENT_WAKE_TEXT), { action: "continue" });
  assert.equal(r.events("notify_deduped").length, 0);
});

test("r26 stale attention: a mixed batch (ended and live notices) continues", async (t) => {
  const r = await r11Rig(t);
  const branch: unknown[] = [];
  Object.assign(r.ctx.sessionManager, { getBranch: () => branch });
  endRun(r, "run-ended");
  branch.push(entry(notice("run-ended")), entry(notice("run-live")));
  assert.deepEqual(await r.inputRun("extension", SUBAGENT_WAKE_TEXT), { action: "continue" });
  assert.equal(r.events("notify_deduped").length, 0);
});

test("r26 stale attention: an owner prompt with only an ended-run notice continues", async (t) => {
  const r = await r11Rig(t);
  const branch: unknown[] = [];
  Object.assign(r.ctx.sessionManager, { getBranch: () => branch });
  endRun(r, "run-ended");
  branch.push(entry(notice("run-ended")));
  assert.deepEqual(await r.inputRun("interactive", "status?"), { action: "continue" });
  assert.equal(r.events("notify_deduped").length, 0);
});
