// r75 item 7, r79 item 11: a codemode script's inner calls are decided by the gate like direct calls. Pi runs each one through its tool pipeline
// (dist/core/agent-session.js _executeNestedToolCall -> beforeToolCall -> extension `tool_call`, id `<callerId>/<n>`), so the adapter's one
// tool_call handler sees them: floors, the judge-first list and the judge. The judge's cache never carries a verdict from one call
// to another (the key is the full call text).
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";

const V = (verdict: "clear" | "unsure"): string => JSON.stringify({ verdict, reason: `because ${verdict}` });
const config = { providers: { fake: { roles: { review: { model: "m" } } } } };

function fakeRegistry(replies: string[]) {
  const calls: string[] = [];
  const registry = {
    find: () => ({ id: "m" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async (_m: never, ctx: { messages: { content: string }[] }) => {
      calls.push(ctx.messages[0].content);
      return { content: [{ type: "text", text: replies[Math.min(calls.length - 1, replies.length - 1)] }], stopReason: "stop", usage: { input: 1, output: 1 } };
    },
  };
  return { registry, calls };
}

async function rig(t: Parameters<typeof r11Rig>[0], replies: string[]) {
  const reg = fakeRegistry(replies);
  const r = await r11Rig(t, {}, { ctx: { modelRegistry: reg.registry }, config });
  /** A nested call: the id is `<callerId>/<n>`, as Pi gives it. */
  const inner = async (toolName: string, input: Record<string, unknown>, id: string): Promise<{ block?: boolean; reason?: string } | undefined> =>
    (await r.fire("tool_call", { toolName, toolCallId: id, input })) as { block?: boolean; reason?: string } | undefined;
  return { ...r, reg, inner };
}

test("inner bash and write of a codemode script that are floor denials when direct are denied inside codemode", async (t) => {
  const r = await rig(t, [V("clear")]);
  assert.equal((await r.call("bash", { command: "rm -rf /" }))?.block, true);
  assert.equal((await r.call("write", { path: "~/.ssh/id_rsa", content: "x" }))?.block, true);
  const before = r.reg.calls.length;
  const bash = await r.inner("bash", { command: "rm -rf /" }, "cm1/1");
  assert.equal(bash?.block, true);
  const write = await r.inner("write", { path: "~/.ssh/id_rsa", content: "x" }, "cm1/2");
  assert.equal(write?.block, true);
  assert.equal(r.reg.calls.length, before, "floors decide without a classifier call");
});

test("an inner call on the judge-first list that the judge does not clear is not run, and an inner call reaches the judge at all", async (t) => {
  const r = await rig(t, [V("unsure")]);
  const res = await r.inner("bash", { command: "git branch -D old-branch" }, "cm2/1");
  assert.equal(res?.block, true);
  assert.equal(r.reg.calls.length, 1);
  assert.match(r.reg.calls[0], /tool: bash/);
  assert.match(r.reg.calls[0], /git branch -D old-branch/);
});

test("two different inner calls in a row never share a verdict: unsure then clear, clear then unsure", async (t) => {
  for (const [first, second] of [["unsure", "clear"], ["clear", "unsure"]] as const) {
    const r = await rig(t, [V(first), V(second)]);
    const a = await r.inner("bash", { command: "git branch -D branch-a" }, "cm3/1");
    const b = await r.inner("bash", { command: "git branch -D branch-b" }, "cm3/2");
    assert.equal(Boolean(a?.block), first === "unsure");
    assert.equal(Boolean(b?.block), second === "unsure");
    assert.equal(r.reg.calls.length, 2);
  }
});
