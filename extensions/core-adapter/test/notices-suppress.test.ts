// "Subagent needs attention" for an open bash call: a known long command (test runner) is hidden, and a child without a command
// controller loses the `command.*` lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { AttentionNotices, dropSuppressedNotices, staleNoticeRunIds, trimAttentionNotice, trimNoticeMessage } from "../notices.ts";
import { writeOpenCommand } from "../opencommand.ts";
import { SUBAGENT_WAKE_TEXT } from "../idlecustom.ts";
import { r11Rig } from "./_r11rig.ts";

const TEXT = [
  "Subagent needs attention: builder run-1",
  "Hint: Inspect the running command.",
  "Recovery: For a local Pi child explicitly granted subagent_command, yield or cancel.",
  'Command: subagent({"action":"command.status","id":"run-1"})',
  'Yield: subagent({"action":"command.yield","id":"run-1"})',
  'Cancel: subagent({"action":"command.cancel","id":"run-1"})',
  'Transcript: subagent({ action: "status", id: "run-1" })',
].join("\n");

const notice = (runId: string, toolCallId = "tc1") => ({
  role: "custom",
  customType: "subagent_control_notice",
  content: TEXT,
  display: true,
  details: { noticeText: TEXT, event: { type: "needs_attention", reason: "tool_open_threshold", runId, toolCallId, currentTool: "bash" } },
});

test("trimAttentionNotice: without a controller the command lines go and Recovery is replaced", () => {
  const out = trimAttentionNotice(TEXT, { hasCommandController: false });
  assert.ok(!/^(Command|Yield|Cancel):/m.test(out));
  assert.match(out, /^Recovery: this child has no command controller/m);
  assert.match(out, /^Hint: /m);
  assert.match(out, /^Transcript: /m);
});

test("trimAttentionNotice: with a controller the text is unchanged", () => {
  assert.equal(trimAttentionNotice(TEXT, { hasCommandController: true }), TEXT);
});

test("trimNoticeMessage: content and details.noticeText are both trimmed", () => {
  const m = trimNoticeMessage(notice("run-1"), { hasCommandController: false });
  assert.ok(m);
  assert.ok(!/Command:/.test(m.content));
  assert.ok(!/Command:/.test(m.details.noticeText));
  assert.equal(trimNoticeMessage(notice("run-1"), { hasCommandController: true }), null);
});

test("suppressed notices leave the model context and make a wake stale", () => {
  const att = new AttentionNotices();
  att.suppress("run-1", "tc1");
  const other = { role: "user", content: "hi" };
  const kept = notice("run-1", "tc2");
  const r = dropSuppressedNotices([notice("run-1"), other, kept], att.suppressed);
  assert.deepEqual(r?.messages, [other, kept]);
  assert.equal(dropSuppressedNotices([other], att.suppressed), null);
  assert.deepEqual(staleNoticeRunIds([notice("run-1")], new Set(), att.suppressed), ["run-1"]);
  assert.equal(staleNoticeRunIds([notice("run-1", "tc2")], new Set(), att.suppressed), null);
  assert.equal(staleNoticeRunIds([notice("run-1"), other], new Set(), att.suppressed), null);
});

async function liveRun(t: Parameters<typeof r11Rig>[0], command: string) {
  const r = await r11Rig(t, { default: "standard" });
  const input: Record<string, unknown> = { agent: "builder", task: "build" };
  const { id } = await r.launch(input);
  await r.started(id, input, "run-1");
  const dir = /(\S*pi-foreman-scratch\S*)/.exec(String(input.task))?.[1]?.replace(/[`'".,]+$/, "");
  assert.ok(dir, String(input.task));
  writeOpenCommand(path.resolve(dir), { toolCallId: "tc1", command, startedAt: Date.now() - 240_000 });
  return r;
}

test("adapter: a test run's notice is hidden, dropped from the context, and traced", async (t) => {
  const r = await liveRun(t, "cd app && npm test");
  const out = (await r.fire("message_end", { message: notice("run-1") })) as { message: { display: boolean; content: string } };
  assert.equal(out.message.display, false);
  assert.ok(!/Command:/.test(out.message.content));
  const ev = r.events("attention_suppressed");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].reason, "long_command");
  assert.equal(ev[0].rule, "npm test");
  assert.ok((ev[0].ms as number) >= 240_000);
  const ctx = (await r.fire("context", { messages: [notice("run-1"), { role: "user", content: "x" }] })) as { messages: unknown[] } | undefined;
  assert.equal(ctx?.messages.length, 1);
  r.ctx.sessionManager.getBranch = () => [{ type: "custom_message", ...notice("run-1"), content: "idle copy" }] as never[];
  assert.deepEqual(await r.inputRun("extension", SUBAGENT_WAKE_TEXT), { action: "handled" });
});

test("adapter: an unknown command keeps its notice, trimmed", async (t) => {
  const r = await liveRun(t, "npm run build");
  const out = (await r.fire("message_end", { message: notice("run-1") })) as { message: { display: boolean; content: string } };
  assert.equal(out.message.display, true);
  assert.ok(!/Command:/.test(out.message.content));
  assert.match(out.message.content, /no command controller/);
  assert.equal(r.events("attention_suppressed").length, 0);
});
