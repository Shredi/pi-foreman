// D18: the "tool open for N s" signal (reason tool_open_threshold) wakes the parent at most once per open tool call of a run.
// A repeat (the same event delivered again, or on a second channel) is hidden and starts no turn. Keyed on the notice's own
// runId and toolCallId; no command parsing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AttentionNotices, isRepeatOpenNotice, staleNoticeRunIds } from "../notices.ts";
import { SUBAGENT_WAKE_TEXT } from "../idlecustom.ts";
import { r11Rig } from "./_r11rig.ts";

const notice = (runId: string, toolCallId?: string, text = "Subagent needs attention: builder run-1") => ({
  role: "custom",
  customType: "subagent_control_notice",
  content: text,
  display: true,
  details: { noticeText: text, event: { type: "needs_attention", reason: "tool_open_threshold", runId, ...(toolCallId ? { toolCallId } : {}), currentTool: "bash" } },
});

test("openOnce: the first signal of a run and tool call passes, a repeat does not, another call or run passes, no toolCallId always passes", () => {
  const att = new AttentionNotices();
  assert.equal(att.openOnce("run-1", "tc1"), true);
  assert.equal(att.openOnce("run-1", "tc1"), false);
  assert.equal(att.openOnce("run-1", "tc2"), true);
  assert.equal(att.openOnce("run-2", "tc1"), true);
  assert.equal(att.openOnce("run-1", undefined), true);
  assert.equal(att.openOnce("run-1", undefined), true);
});

test("isRepeatOpenNotice and staleNoticeRunIds: a wake with only a repeat is stale, a first or other call is not", () => {
  const att = new AttentionNotices();
  const repeat = (ev: Record<string, unknown>) => isRepeatOpenNotice(att, ev);
  assert.equal(staleNoticeRunIds([notice("run-1", "tc1")], new Set(), new Set(), repeat), null);
  assert.deepEqual(staleNoticeRunIds([notice("run-1", "tc1")], new Set(), new Set(), repeat), ["run-1"]);
  assert.equal(staleNoticeRunIds([notice("run-1", "tc2")], new Set(), new Set(), repeat), null);
  assert.equal(staleNoticeRunIds([notice("run-1")], new Set(), new Set(), repeat), null);
  assert.equal(staleNoticeRunIds([notice("run-1")], new Set(), new Set(), repeat), null);
});

type Rig = Awaited<ReturnType<typeof r11Rig>>;
/** One idle wake carrying `msgs` as unseen notices; returns the input hook's answer. */
async function wake(r: Rig, ...msgs: ReturnType<typeof notice>[]): Promise<unknown> {
  r.ctx.sessionManager.getBranch = () => msgs.map((m) => ({ type: "custom_message", ...m })) as never[];
  return r.inputRun("extension", SUBAGENT_WAKE_TEXT);
}
const wakes = (out: unknown): boolean => (out as { action?: string }).action !== "handled";

test("adapter: one open sleep 600 call whose notice arrives on both channels and again wakes the parent once", async (t) => {
  const r = await r11Rig(t, { default: "standard" });
  const first = notice("run-1", "tc-sleep", "Subagent needs attention: builder run-1 (async record)");
  const intercomCopy = notice("run-1", "tc-sleep", "subagent needs attention\n\nbuilder needs attention in run run-1.\n\nSubagent needs attention: builder run-1");
  assert.equal(wakes(await wake(r, first)), true);
  assert.equal(wakes(await wake(r, intercomCopy)), false);
  assert.equal(wakes(await wake(r, first)), false);
  // the same call delivered while the parent is busy: shown no more, hidden from the display
  const shown = (await r.fire("message_end", { message: first })) as { message: { display: boolean } } | undefined;
  assert.equal(shown?.message.display, false);
  assert.ok(r.events("notify_deduped").some((e) => e.reason === "tool_open_repeat"));
});

test("adapter: another tool call of the same run still wakes once; a notice without toolCallId passes unchanged", async (t) => {
  const r = await r11Rig(t, { default: "standard" });
  assert.equal(wakes(await wake(r, notice("run-1", "tc1"))), true);
  assert.equal(wakes(await wake(r, notice("run-1", "tc2"))), true);
  assert.equal(wakes(await wake(r, notice("run-1", "tc2"))), false);
  assert.equal(wakes(await wake(r, notice("run-1"))), true);
  assert.equal(wakes(await wake(r, notice("run-1"))), true);
  const out = (await r.fire("message_end", { message: notice("run-3") })) as { message?: { display: boolean } } | undefined;
  assert.notEqual(out?.message?.display, false);
});

test("adapter: the first message_end copy shows, the repeat is hidden", async (t) => {
  const r = await r11Rig(t, { default: "standard" });
  const a = (await r.fire("message_end", { message: notice("run-1", "tc1") })) as { message?: { display: boolean } } | undefined;
  assert.notEqual(a?.message?.display, false);
  const b = (await r.fire("message_end", { message: notice("run-1", "tc1") })) as { message: { display: boolean } };
  assert.equal(b.message.display, false);
});
