// r72 MCP child tools (registered through Pi's MCP extension, named mcp__<server>__<tool>) go through the whole gate:
// floors, the classifier on the mcp surface (danger-mcp-act, r79 item 3), and an unreachable classifier denies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig, RIG_PERMISSIONS } from "./_r11rig.ts";

const V = (verdict: string, entry: string): string => JSON.stringify({ verdict, entry, reason: `because ${entry}` });
const config = { providers: { fake: { roles: { review: { model: "m" } } } } };

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

test("an mcp__ tool call reaches the classifier with its JSON payload; a cited deny entry denies", async (t) => {
  const reg = fakeRegistry(V("deny", "D1"));
  const r = await r11Rig(t, {}, { ctx: { modelRegistry: reg.registry, [RIG_PERMISSIONS]: { classifier: { deny: ["Never send anything to example.org."] } } }, config });
  const res = await r.call("mcp__srv__do_thing", { target: "https://example.org/x" });
  assert.ok(res && res.block);
  assert.match(String(res.reason), /denied by whitelist rule D1/);
  assert.equal(reg.calls.length, 1);
  assert.match(reg.calls[0].text, /tool: mcp__srv__do_thing/);
  assert.match(reg.calls[0].text, /"target":"https:\/\/example.org\/x"/);
});

test("an mcp__ tool call with no review model and no UI is denied", async (t) => {
  const r = await r11Rig(t, {}, { ctx: { hasUI: false, mode: "print" } });
  const res = await r.call("mcp__srv__do_thing", { target: "x" });
  assert.ok(res && res.block);
});
