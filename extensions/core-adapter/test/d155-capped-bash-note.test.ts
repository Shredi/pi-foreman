// D155: a child's bash call whose `timeout` was capped gets a line at that call's result; an uncapped call gets none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

type Rig = Awaited<ReturnType<typeof r11Rig>>;
/** One bash call, tool_call then its tool_result; the result text the hooks gave back. */
async function bash(rig: Rig, id: string, input: Record<string, unknown>): Promise<string> {
  await rig.fire("tool_call", { toolName: "bash", toolCallId: id, input });
  const r = (await rig.fire("tool_result", { toolName: "bash", toolCallId: id, input, content: [{ type: "text", text: "ok" }], isError: false })) as { content?: { text: string }[] } | undefined;
  return (r?.content ?? []).map((c) => c.text).join("\n");
}

test("a child bash call over the cap: that call's result carries the cap line", async (t) => {
  const rig = await r11Rig(t, { childBashTimeoutMaxSeconds: 900 }, { ...reviewAllowOpts(), child: true });
  const text = await bash(rig, "c1", { command: "echo ok", timeout: 7200 });
  assert.match(text, /pi-foreman: timeout 7200 s was capped to 900 s \(child bash cap, docs\/safety\.md\)/);
});

test("a child bash call within the cap or with no timeout: no cap line; a capped call's line does not reach another call", async (t) => {
  const rig = await r11Rig(t, { childBashTimeoutMaxSeconds: 900 }, { ...reviewAllowOpts(), child: true });
  await rig.fire("tool_call", { toolName: "bash", toolCallId: "big", input: { command: "echo ok", timeout: 7200 } });
  assert.doesNotMatch(await bash(rig, "ok1", { command: "echo ok", timeout: 120 }), /capped/);
  assert.doesNotMatch(await bash(rig, "ok2", { command: "echo ok" }), /capped/);
});
