// D23: a launch receipt has no side effect on the high-stakes state: an explorer receipt on the heavy tier stores no `heavy` reason.
import assert from "node:assert/strict";
import { test } from "node:test";
import { tick, world } from "./_r46world.ts";

process.env.PI_OFFLINE = "1";

async function launch(a: Awaited<ReturnType<ReturnType<typeof world>["adapter"]>>, input: Record<string, unknown>): Promise<string> {
  const id = `g${Math.random().toString(36).slice(2, 8)}`;
  await a.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } });
  const call = (await a.fire("tool_call", { toolName: "subagent", toolCallId: id, input })) as { block?: boolean; reason?: string } | undefined;
  assert.ok(!call?.block, String(call?.reason));
  await a.fire("tool_result", { toolName: "subagent", toolCallId: id, input, details: { runId: `run-${id}` }, content: [{ type: "text", text: "started" }], isError: false });
  await tick(100);
  return id;
}

for (const input of [{ agent: "explorer", task: "look around" }]) {
  test(`a ${input.agent} launch receipt on the heavy tier stores no heavy reason`, async (t) => {
    const w = world(t, { ceremony: { default: "standard", highStakes: { model: "fake/hs" } } });
    const a = await w.adapter("startup");
    await a.writeLedger("# Ledger: x\nTier: standard\n\n- [ ] 1. item\n");
    const b = await launch(a, { agent: "builder", task: "build the widget" });
    a.endRunAs(b, "builder", "done");
    await tick(150);
    await a.command("ceremony", "heavy");
    await launch(a, input);
    const stakes = (await w.traceEvents()).filter((e) => e.event === "review_stakes");
    assert.deepEqual(stakes, []);
  });
}
