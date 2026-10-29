// r72 MCP child tools (registered through Pi's MCP extension, named mcp__<server>__<tool>) go through the whole gate:
// floors, review on the mcp surface, and an unreachable review denies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";

const V = (verdict: string, entry: string): string => JSON.stringify({ verdict, entry, reason: `because ${entry}` });
const config = { providers: { fake: { review: { model: "m" }, roles: {} } } };

function fakeRegistry(reply: string) {
  const calls: { text: string }[] = [];
  const registry = {
    find: () => ({ id: "m" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async (_m: never, ctx: { messages: { content: string }[] }) => {
      calls.push({ text: ctx.messages[0].content });
      return { content: [{ type: "text", text: reply }], stopReason: "stop", usage: { input: 1, output: 1 } };
    },
  };
  return { registry, calls };
}

test("an mcp__ tool call reaches the review with its JSON payload", async (t) => {
  const reg = fakeRegistry(V("deny", "unknown-network-host"));
  const r = await r11Rig(t, {}, { ctx: { modelRegistry: reg.registry }, config });
  const res = await r.call("mcp__srv__do_thing", { target: "https://example.org/x" });
  assert.ok(res && res.block);
  assert.equal(reg.calls.length, 1);
  assert.match(reg.calls[0].text, /tool: mcp__srv__do_thing/);
  assert.match(reg.calls[0].text, /"target":"https:\/\/example.org\/x"/);
});

test("an mcp__ tool call with no review model and no UI is denied", async (t) => {
  const r = await r11Rig(t, {}, { ctx: { hasUI: false, mode: "print" } });
  const res = await r.call("mcp__srv__do_thing", { target: "x" });
  assert.ok(res && res.block);
});
