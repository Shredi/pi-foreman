// Prompt cache: the `context` hook never changes a message already sent to the model (notices.ts stableNoticeFilter);
// later state (suppressed notice, ended run, delivered result) reaches only messages not yet sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { stableNoticeFilter } from "../notices.ts";
import { writeOpenCommand } from "../opencommand.ts";
import { r11Rig } from "./_r11rig.ts";

const notice = (runId: string, toolCallId: string, extra = "") => ({
  role: "custom",
  customType: "subagent_control_notice",
  content: `Subagent needs attention: builder ${runId}${extra}`,
  display: true,
  details: { event: { type: "needs_attention", reason: "tool_open_threshold", runId, toolCallId, currentTool: "bash" } },
});
const user = { role: "user", content: "go" };
type Ctx = { messages: unknown[] } | undefined;

test("adapter: sent notices stay byte-identical across suppress, run end and a later notice", async (t) => {
  const r = await r11Rig(t, { default: "standard" });
  const input: Record<string, unknown> = { agent: "builder", task: "build" };
  const { id } = await r.launch(input);
  await r.started(id, input, "run-1");
  const dir = /(\S*pi-foreman-scratch\S*)/.exec(String(input.task))?.[1]?.replace(/[`'".,]+$/, "");
  assert.ok(dir, String(input.task));

  const sent1 = [user, notice("run-1", "tc1")];
  const before1 = structuredClone(sent1);
  const first = (await r.fire("context", { messages: structuredClone(sent1) })) as Ctx;
  assert.equal(first, undefined, "live run: nothing dropped");

  // the notice's own command is now known to be a long test run: suppressed from here on
  writeOpenCommand(path.resolve(dir), { toolCallId: "tc1", command: "npm test", startedAt: Date.now() - 240_000 });
  await r.fire("message_end", { message: notice("run-1", "tc1") });
  const sent2 = [...structuredClone(before1), { role: "assistant", content: "ok" }, notice("run-1", "tc2")];
  const second = (await r.fire("context", { messages: structuredClone(sent2) })) as Ctx;
  assert.deepEqual(second, undefined, "the sent tc1 notice stays; tc2 is a live notice");

  r.end({ runId: "run-1", agent: "builder", success: true, summary: "done", results: [{ agent: "builder" }] });
  const sent3 = [...structuredClone(sent2), notice("run-1", "tc3"), { role: "user", content: "next" }];
  const third = (await r.fire("context", { messages: structuredClone(sent3) })) as Ctx;
  assert.deepEqual(third?.messages, [...sent2, { role: "user", content: "next" }], "earlier messages byte-identical; only the unsent notice of the ended run is dropped");
});

test("stableNoticeFilter: a verdict is kept once made; a new message takes the fresh one", () => {
  const memo = new Map<string, boolean>();
  const a = notice("r1", "c1");
  const b = notice("r2", "c1");
  // first sight: a kept, b dropped
  assert.deepEqual(stableNoticeFilter([user, a, b], [user, a], memo), [user, a]);
  // later the fresh filter flips both: a would drop, b would be kept
  assert.deepEqual(stableNoticeFilter(structuredClone([user, a, b]), [user, structuredClone(b)], memo), [user, a]);
  // a new message is judged fresh
  const c = notice("r3", "c1");
  const msgs = structuredClone([user, a, b, c]);
  assert.deepEqual(stableNoticeFilter(msgs, [msgs[0], msgs[3]], memo), [user, a, c]);
  // a compaction removes messages: their entries go
  stableNoticeFilter([user], [user], memo);
  assert.equal(memo.size, 0);
});
