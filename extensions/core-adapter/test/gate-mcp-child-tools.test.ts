// r72 MCP child tools (registered through Pi's MCP extension, named mcp__<server>__<tool>) go through the whole gate: the payload floors decide, and
// since PR C no judge reads an mcp call (the danger-mcp-act entry is gone): a call no floor names runs, with or without a UI or a review model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";

const config = { providers: { fake: { roles: { review: { model: "m" } } } } };

function fakeRegistry() {
  const calls: { text: string }[] = [];
  const registry = {
    find: () => ({ id: "m" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async (_m: never, ctx: { messages: { content: string }[] }) => {
      calls.push({ text: ctx.messages[0].content });
      return { content: [{ type: "text", text: JSON.stringify({ verdict: "unsure", reason: "x" }) }], stopReason: "stop", usage: { input: 1, output: 1 } };
    },
  };
  return { registry, calls };
}

test("an mcp__ tool call runs with no judge call", async (t) => {
  const reg = fakeRegistry();
  const r = await r11Rig(t, {}, { ctx: { modelRegistry: reg.registry }, config });
  assert.equal(await r.call("mcp__srv__do_thing", { target: "https://example.org/x" }), undefined);
  assert.equal(reg.calls.length, 0);
});

test("an mcp__ tool call with no review model and no UI runs too", async (t) => {
  const r = await r11Rig(t, {}, { ctx: { hasUI: false, mode: "print" } });
  assert.equal(await r.call("mcp__srv__do_thing", { target: "x" }), undefined);
});

test("an mcp__ tool call whose payload names a secret path meets the secret floor", async (t) => {
  const r = await r11Rig(t, {}, { ctx: { hasUI: false, mode: "print" } });
  const res = await r.call("mcp__srv__do_thing", { path: "~/.ssh/id_rsa" });
  assert.equal(res?.block, true);
  assert.match(String(res?.reason), /denied by the permission floor/);
});
